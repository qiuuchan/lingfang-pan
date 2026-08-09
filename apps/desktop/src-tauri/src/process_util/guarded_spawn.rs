//! 统一子进程 spawn 入口（P1-3 / M-2，Step 0 + Step 1）。
//!
//! **动机**：加固前全仓库有 8 类 spawn 通道，只有「长驻插件入口」一条挂了 Job Object，
//! 且是 `spawn()` 之后才 assign（有竞态窗口）。每加一项隔离措施都要改 N 处。
//! 本模块把「构造命令 → spawn → 套沙箱 → 放行」收敛成一个入口，后续加固只改这里。
//!
//! **本模块负责**：
//! - Windows：`CREATE_SUSPENDED` 起进程 → 建 Job（含资源配额/UI 限制）→ `AssignProcessToJobObject`
//!   → 枚举线程 `ResumeThread`。进程在入 Job 之前**一条用户指令都没执行**，彻底消除竞态（R4）。
//! - 沙箱失败时按插件来源档位决定 fail-closed 还是降级（见 [`SandboxTier`]）。
//! - `CREATE_NO_WINDOW`：插件进程不再能弹控制台做 UI 欺骗（R12）。
//!
//! **本模块不负责**（留给后续 Step，见 P1-3 计划）：
//! - Step 2 降权（受限令牌 / 低完整性）、Step 3 桥 token 改道、Step 4 防 manifest 自我提权、
//!   Step 5 Unix/macOS 补齐（当前 Unix 侧仅 `setsid`，无 PDEATHSIG）。
//!
//! **不走本模块的通道**（宿主自操作，不执行任何插件代码，故不需要围栏）：
//! `plugin_package_manager/helpers.rs` 的 `mklink`、`plugin_runner.rs` 的 `rmdir` 兜底删目录、
//! `plugin_store.rs` 的 `explorer/open/xdg-open`、`update.rs` 的自更新器。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};

use super::binary::build_spawn_command;
use super::sandbox::SandboxHandle;

/// 逃生开关：置 `1` 时任何档位都不 fail-closed，只降级 + log。
///
/// 用途：Windows 家庭版/受限企业策略/容器等 Job Object 不可用的环境，避免插件完全不能启动。
const SANDBOX_SOFT_ENV: &str = "LINGFANG_SANDBOX_SOFT";

/// 插件来源档位 → 沙箱失败时的行为。
///
/// **决策源只用「插件目录是否在 `plugins_root`」这一个不可自述的信号**。
///
/// 为什么不再按「内置 / 远端签名 / 本地草稿」分三档：草稿身份来自 `manifest.draft`，
/// 而 `PluginMeta.draft` 也只是它的转写——两者都是**插件自己写在磁盘上的声明**，
/// 插件子进程可随时改（R2）。若拿它决定「沙箱失败时降级放行」，等于给攻击者
/// 一个自助降级开关。在 Step 4 建立防篡改的安装侧草稿记录之前，
/// `plugins_root` 下的插件（远端安装 + 本地草稿）一律按不可信处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxTier {
    /// 内置插件：不在 `plugins_root` 的官方 bundle，随应用分发、注册时已鉴权。
    /// 本地可信 → 沙箱失败降级 + log，不阻断启动。
    Builtin,
    /// 用户安装的插件：位于 `plugins_root`（远端签名安装 或 本地草稿）。
    /// 来源不可信 → **沙箱失败即 fail-closed**：套不上围栏就不许跑。
    /// 逃生开关 `LINGFANG_SANDBOX_SOFT=1` 可临时降级（供 Job Object 不可用的异常环境）。
    UserInstalled,
    /// 豁免：宿主自身的工具链调用（venv 创建、pip/pnpm 安装、运行时探测、Agent 开发 shell）。
    /// Step 0 保持零行为变更；Step 6 再逐通道换成真实策略。
    Exempt,
}

impl SandboxTier {
    /// 沙箱不可用时是否拒绝启动。
    fn fail_closed(self) -> bool {
        matches!(self, SandboxTier::UserInstalled)
            && !matches!(std::env::var(SANDBOX_SOFT_ENV).as_deref(), Ok("1"))
    }
}

/// Job Object 资源配额与 UI 限制。数值来自 Batch A 实测（见 P1-3 计划 §4 spike 清单）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct SandboxPolicy {
    pub(crate) tier: SandboxTier,
    /// Job 内活跃进程数上限（0 = 不限）。挡 fork bomb。
    pub(crate) active_process_limit: u32,
    /// 单进程提交内存上限（字节，0 = 不限）。挡单进程吃爆内存。
    pub(crate) process_memory_limit: u64,
    /// CPU 硬上限，单位 1/100 %，全系统口径（0 = 不限）。给宿主 UI 留调度余量。
    pub(crate) cpu_rate: u32,
    /// `JOB_OBJECT_UILIMIT_*` 位组合（0 = 不限）。
    pub(crate) ui_restrictions: u32,
}

// ── UI 限制位（Win32 JOB_OBJECT_UILIMIT_*）──────────────────────────
#[allow(dead_code)]
mod uilimit {
    pub(super) const HANDLES: u32 = 0x0000_0001;
    pub(super) const READCLIPBOARD: u32 = 0x0000_0002;
    pub(super) const WRITECLIPBOARD: u32 = 0x0000_0004;
    pub(super) const SYSTEMPARAMETERS: u32 = 0x0000_0008;
    pub(super) const DISPLAYSETTINGS: u32 = 0x0000_0010;
    pub(super) const GLOBALATOMS: u32 = 0x0000_0020;
    pub(super) const DESKTOP: u32 = 0x0000_0040;
    pub(super) const EXITWINDOWS: u32 = 0x0000_0080;
}

/// 默认启用的 UI 限制：只取「插件无正当用途 + 实测零兼容成本」的三位。
///
/// 实测依据（Tkinter `calculator` 与 Playwright/Chromium 真实路径各 22 组用例全通过）：
/// - `SYSTEMPARAMETERS`：禁改系统级参数（壁纸/屏保/辅助功能钩子——钩子是经典键盘记录入口）。
/// - `DISPLAYSETTINGS`：禁改分辨率/刷新率。
/// - `EXITWINDOWS`：禁关机/重启/注销。
///
/// **刻意不启用**（每条都有实测或代码依据，勿随手加回来）：
/// - `DESKTOP`：裸 `chrome.exe` 在此位下硬崩（退出码 `0xC0000003`，仅起 2~3 个进程），
///   Chromium 沙箱要 `CreateDesktop`。`qianniu-panel` 依赖 Playwright/Chromium，风险实打实。
/// - `READCLIPBOARD` / `WRITECLIPBOARD`：`detail-poster` 用 Tk `clipboard_append` +
///   `ImageGrab.grabclipboard()`、`rbflow-video` 用 Qt `QApplication.clipboard()`，开了直接坏 2 个插件。
/// - `HANDLES`：安全价值最高（挡跨窗口消息注入 / UI 欺骗），Tkinter 与 Chromium 实测均通过，
///   但 Qt（`rbflow-video`）未验证；且在 Step 2 降权落地前，插件本来就能 `OpenProcess` 读宿主内存（R3），
///   单开这一位收益有限。**留给 Step 2 与降权一起上，并跑完 Qt 插件矩阵后再启用。**
/// - `GLOBALATOMS`：收益低。
const UI_RESTRICTIONS_DEFAULT: u32 =
    uilimit::SYSTEMPARAMETERS | uilimit::DISPLAYSETTINGS | uilimit::EXITWINDOWS;

impl SandboxPolicy {
    /// 长驻插件入口进程的策略。
    ///
    /// 配额取值：Chromium（headed，3 个 context）实测 Job 内峰值 12 个活跃进程，
    /// 故进程数上限 64 留足 5 倍余量，只挡 fork bomb；单进程内存 4 GiB
    /// （本机 32 GiB，pandas 类插件不会触顶）；CPU 硬上限 80% 给宿主 UI 留调度余量。
    pub(crate) fn plugin_entry(tier: SandboxTier) -> Self {
        SandboxPolicy {
            tier,
            active_process_limit: 64,
            process_memory_limit: 4 * 1024 * 1024 * 1024,
            cpu_rate: 8000,
            ui_restrictions: UI_RESTRICTIONS_DEFAULT,
        }
    }

    /// 豁免策略：不建 Job，行为与加固前完全一致。
    pub(crate) fn exempt() -> Self {
        SandboxPolicy {
            tier: SandboxTier::Exempt,
            active_process_limit: 0,
            process_memory_limit: 0,
            cpu_rate: 0,
            ui_restrictions: 0,
        }
    }

    /// 是否需要建 Job Object。
    fn needs_sandbox(&self) -> bool {
        !matches!(self.tier, SandboxTier::Exempt)
    }
}

/// 统一 spawn 构造器。
pub(crate) struct GuardedCommand {
    binary: PathBuf,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    /// `Some` → `env_clear()` 后注入这批（插件进程一律白名单式环境）；`None` → 继承父进程环境。
    env: Option<Vec<(OsString, OsString)>>,
    policy: SandboxPolicy,
    stdin: Stdio,
    stdout: Stdio,
    stderr: Stdio,
}

/// spawn 结果：子进程 + 与之绑定的沙箱句柄。
///
/// `sandbox` 必须与 `child` 同生命周期存活：句柄 drop → `KILL_ON_JOB_CLOSE` 触发 → 整棵进程树被杀。
pub(crate) struct GuardedChild {
    pub(crate) child: Child,
    pub(crate) sandbox: SandboxHandle,
}

impl GuardedCommand {
    pub(crate) fn new(binary: &Path, args: Vec<String>, policy: SandboxPolicy) -> Self {
        GuardedCommand {
            binary: binary.to_path_buf(),
            args,
            cwd: None,
            env: None,
            policy,
            stdin: Stdio::null(),
            stdout: Stdio::piped(),
            stderr: Stdio::piped(),
        }
    }

    pub(crate) fn cwd(mut self, dir: impl AsRef<Path>) -> Self {
        self.cwd = Some(dir.as_ref().to_path_buf());
        self
    }

    /// 可选 cwd：`None` 时继承父进程工作目录。
    pub(crate) fn cwd_opt(mut self, dir: Option<impl AsRef<Path>>) -> Self {
        self.cwd = dir.map(|d| d.as_ref().to_path_buf());
        self
    }

    /// 设置白名单环境（内部会先 `env_clear()`）。
    pub(crate) fn env_exact(mut self, env: Vec<(OsString, OsString)>) -> Self {
        self.env = Some(env);
        self
    }

    /// 可选白名单环境：`None` 时继承父进程环境。
    pub(crate) fn env_exact_opt(mut self, env: Option<Vec<(OsString, OsString)>>) -> Self {
        self.env = env;
        self
    }

    /// spawn 并套上沙箱。
    ///
    /// `on_log` 用于把沙箱降级/失败原因写进调用方的启动日志（长驻插件写 `.launch.log`）。
    pub(crate) fn spawn<F>(self, mut on_log: F) -> Result<GuardedChild, String>
    where
        F: FnMut(String),
    {
        let mut command = build_spawn_command(&self.binary, &self.args);
        command
            .stdin(self.stdin)
            .stdout(self.stdout)
            .stderr(self.stderr);
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = &self.env {
            command
                .env_clear()
                .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())));
        }

        #[cfg(unix)]
        {
            // Unix：setsid 做进程组分离（stop 时按进程组 kill）。
            // 注意：这里**没有** PR_SET_PDEATHSIG——宿主被强杀时插件进程仍会残留，属 Step 5 待补。
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    super::tree::libc_setsid();
                    Ok(())
                });
            }
            let child = command.spawn().map_err(|error| error.to_string())?;
            let _ = &mut on_log;
            return Ok(GuardedChild {
                child,
                sandbox: SandboxHandle::default(),
            });
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NEW_PROCESS_GROUP：进程组隔离，stop 时可整组 kill。
            // CREATE_NO_WINDOW：不给插件弹控制台窗口（R12：控制台可被用来做 UI 欺骗）。
            // CREATE_SUSPENDED：主线程挂起起进程，等入 Job 后再放行 —— 消除 R4 竞态。
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_SUSPENDED: u32 = 0x0000_0004;

            let mut flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
            if self.policy.needs_sandbox() {
                flags |= CREATE_SUSPENDED;
            }
            // 注意 creation_flags 是覆盖语义，必须一次性设全（build_spawn_command 里也设过）。
            command.creation_flags(flags);

            let child = command.spawn().map_err(|error| error.to_string())?;
            if !self.policy.needs_sandbox() {
                return Ok(GuardedChild {
                    child,
                    sandbox: SandboxHandle::default(),
                });
            }

            // 进程此刻处于挂起态：一条用户指令都没执行，此时入 Job 无竞态窗口。
            let sandbox = match attach_sandbox(&self.policy, &child) {
                Ok(handle) => {
                    on_log("OS 级沙箱已就绪（Job Object：进程树围栏 + 资源配额 + UI 限制）".to_string());
                    handle
                }
                Err(error) => {
                    if self.policy.tier.fail_closed() {
                        // fail-closed：进程还挂着，直接终止，绝不放行未受围栏的第三方代码。
                        terminate_suspended(&child);
                        return Err(format!(
                            "插件沙箱不可用，已拒绝启动（用户安装的插件强制隔离）：{error}。\
                             如需临时放行，设置环境变量 {SANDBOX_SOFT_ENV}=1"
                        ));
                    }
                    on_log(format!("沙箱不可用，降级为无围栏运行：{error}"));
                    SandboxHandle::default()
                }
            };

            // 放行：无论沙箱成败都必须恢复线程，否则进程永久挂起变僵尸。
            if let Err(error) = resume_process_threads(child.id()) {
                terminate_suspended(&child);
                return Err(format!("恢复插件进程主线程失败，已终止：{error}"));
            }

            Ok(GuardedChild { child, sandbox })
        }
    }
}

/// 建 Job（含配额）并把挂起中的进程纳入。
#[cfg(windows)]
fn attach_sandbox(policy: &SandboxPolicy, child: &Child) -> Result<SandboxHandle, String> {
    let handle = SandboxHandle::create_with_policy(policy)?;
    handle.assign_process(child)?;
    Ok(handle)
}

/// 终止一个仍处于挂起态的子进程（fail-closed / 放行失败时用）。
///
/// `TerminateProcess` 对挂起进程同样生效，不需要先 resume。
#[cfg(windows)]
fn terminate_suspended(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Threading::TerminateProcess;
    let handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    unsafe {
        let _ = TerminateProcess(handle, 1);
    }
}

/// 恢复进程内全部线程。
///
/// 为什么不用 `ResumeThread(hThread)`：Rust `std::process::Child` 只暴露进程句柄，拿不到
/// `CreateProcess` 返回的主线程句柄。改用 ToolHelp 快照按 owner PID 枚举线程逐个 resume——
/// 全文档化 API，且进程处于挂起态时不可能冒出新线程，枚举结果必然完整。
///
/// 返回被恢复的线程数（正常应为 1，即主线程）。
#[cfg(windows)]
fn resume_process_threads(pid: u32) -> Result<u32, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "CreateToolhelp32Snapshot(SNAPTHREAD) 失败：{}",
            std::io::Error::last_os_error()
        ));
    }

    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut resumed = 0u32;
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while has_entry {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                // ResumeThread 返回上一次的挂起计数，u32::MAX 表示失败。
                let previous = unsafe { ResumeThread(thread) };
                unsafe { CloseHandle(thread) };
                if previous != u32::MAX {
                    resumed += 1;
                }
            }
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };

    if resumed == 0 {
        return Err(format!(
            "未能恢复 pid={pid} 的任何线程：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(resumed)
}

// ── 单元测试 ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exempt_policy_does_not_sandbox() {
        assert!(!SandboxPolicy::exempt().needs_sandbox());
    }

    #[test]
    fn plugin_tiers_all_need_sandbox() {
        for tier in [SandboxTier::Builtin, SandboxTier::UserInstalled] {
            assert!(
                SandboxPolicy::plugin_entry(tier).needs_sandbox(),
                "{tier:?} 必须建 Job"
            );
        }
    }

    #[test]
    fn only_user_installed_fails_closed() {
        // 用户安装的插件套不上围栏必须拒启动；内置 bundle 降级放行。
        assert!(SandboxTier::UserInstalled.fail_closed());
        assert!(!SandboxTier::Builtin.fail_closed());
        assert!(!SandboxTier::Exempt.fail_closed());
    }

    #[test]
    fn default_ui_restrictions_exclude_known_breakers() {
        // 这三位有实测/代码依据证明会坏插件，回归时必须仍然不在默认集里。
        assert_eq!(UI_RESTRICTIONS_DEFAULT & uilimit::DESKTOP, 0, "DESKTOP 会崩 Chromium");
        assert_eq!(
            UI_RESTRICTIONS_DEFAULT & (uilimit::READCLIPBOARD | uilimit::WRITECLIPBOARD),
            0,
            "剪贴板限制会坏 detail-poster / rbflow-video"
        );
        assert_eq!(
            UI_RESTRICTIONS_DEFAULT & uilimit::HANDLES,
            0,
            "HANDLES 留给 Step 2 与降权同批上"
        );
        // 三位零成本限制必须都在。
        assert_eq!(
            UI_RESTRICTIONS_DEFAULT,
            uilimit::SYSTEMPARAMETERS | uilimit::DISPLAYSETTINGS | uilimit::EXITWINDOWS
        );
    }

    #[test]
    fn entry_quota_leaves_headroom_for_chromium() {
        // Chromium headed 实测 Job 内峰值 12 个活跃进程，配额必须留足余量。
        let policy = SandboxPolicy::plugin_entry(SandboxTier::Builtin);
        assert!(policy.active_process_limit >= 48, "进程数配额过紧会打爆 Playwright");
        assert!(policy.process_memory_limit >= 2 * 1024 * 1024 * 1024);
        assert!(policy.cpu_rate > 0 && policy.cpu_rate <= 10_000);
    }

    /// 端到端：挂起起进程 → 入 Job → 恢复线程，进程必须真的跑起来并正常退出。
    /// 这是 R4 竞态修复的回归用例——若 resume 漏做，进程会永久挂起，此测试超时失败。
    #[test]
    #[cfg(windows)]
    fn suspended_spawn_is_resumed_and_runs() {
        use std::path::PathBuf;

        let policy = SandboxPolicy::plugin_entry(SandboxTier::Builtin);
        let guarded = GuardedCommand::new(
            &PathBuf::from("cmd"),
            vec!["/C".to_string(), "echo guarded-ok".to_string()],
            policy,
        )
        .spawn(|_| {})
        .expect("挂起态 spawn + 入 Job + 放行应成功");

        let output = guarded
            .child
            .wait_with_output()
            .expect("子进程应能正常收敛");
        assert!(output.status.success(), "退出码应为 0");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("guarded-ok"),
            "进程未被放行或未执行：{stdout}"
        );
    }

    /// 豁免策略不建 Job，行为与加固前一致（Step 0 的零行为变更保证）。
    #[test]
    fn exempt_spawn_still_runs() {
        use std::path::PathBuf;

        #[cfg(windows)]
        let (bin, args) = ("cmd", vec!["/C".to_string(), "echo exempt-ok".to_string()]);
        #[cfg(not(windows))]
        let (bin, args) = ("sh", vec!["-c".to_string(), "echo exempt-ok".to_string()]);

        let guarded = GuardedCommand::new(&PathBuf::from(bin), args, SandboxPolicy::exempt())
            .spawn(|_| {})
            .expect("豁免策略 spawn 应成功");
        let output = guarded.child.wait_with_output().expect("应能收敛");
        assert!(String::from_utf8_lossy(&output.stdout).contains("exempt-ok"));
    }
}
