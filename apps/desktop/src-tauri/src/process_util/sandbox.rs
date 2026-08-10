//! 插件进程 OS 级沙箱（P1-3 / M-2）。
//!
//! Windows：用 Job Object 实现「进程树围栏 + 关闭即杀 + 资源配额 + UI 限制」。
//! - `SandboxHandle::create_with_policy()` 创建 Job Object 并写入三组限制：
//!   1. `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`：`KILL_ON_JOB_CLOSE`（句柄关闭即杀整棵树）、
//!      `DIE_ON_UNHANDLED_EXCEPTION`、活跃进程数上限、单进程内存上限。
//!   2. `JOBOBJECT_BASIC_UI_RESTRICTIONS`：禁改系统参数/显示设置、禁关机（见 guarded_spawn 里
//!      `UI_RESTRICTIONS_DEFAULT` 的取舍依据）。
//!   3. `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION`：CPU 硬上限，给宿主 UI 留调度余量。
//! - 不设 `BREAKAWAY_OK`：子进程无法逃逸 Job，所有 spawn 的孙进程自动归入同一 Job。
//! - `assign_process()` 把插件入口进程分配到 Job。调用方（`guarded_spawn`）保证进程此时
//!   仍处于 `CREATE_SUSPENDED` 挂起态 —— 入 Job 之前它一条用户指令都没执行，无竞态窗口。
//! - `Drop` 关闭 Job 句柄 → 触发 KILL_ON_JOB_CLOSE → 整棵进程树被杀。
//!
//! Unix：**Job Object 是 Windows 专有，Unix 侧无等价物**，故 `SandboxHandle` 在 Unix 是空 stub
//! （`Drop` / `assign_process` 都是 no-op）。进程级隔离改在 `guarded_spawn` 的 `pre_exec` 里做
//! （P1-3 Step 5 已落地）：
//! - `setsid()` 进程组分离 → stop 时整组 kill；
//! - Linux `PR_SET_PDEATHSIG(SIGKILL)` → 宿主死亡时子进程随之退出，消除孤儿残留（原 R5）；
//! - 跨平台 `setrlimit(RLIMIT_NPROC / RLIMIT_AS)` → 镜像 Windows Job 的进程数/内存配额。
//! （历史注释曾声称实现了 `prctl(PR_SET_PDEATHSIG, SIGKILL)`，实际从未实现，已订正并真正补齐；
//! macOS 的 PDEATHSIG 等价即 kqueue 看门狗留作 follow-up，cgroup v2 资源隔离亦留后续独立任务。）
//!
//! 与 process_util/tree.rs 的协作：
//! - tree.rs 的 `kill_child_tree` 仍用于主动 stop（先杀进程树再 drop SandboxHandle）。
//! - SandboxHandle 的 Drop 是安全网：即使 kill_child_tree 漏杀孙进程，
//!   Job 句柄关闭也会把整棵树清理干净。

#[cfg(windows)]
use std::process::Child;

#[cfg(windows)]
use super::guarded_spawn::SandboxPolicy;

// ── Windows Job Object 实现 ──────────────────────────────────────────

#[cfg(windows)]
pub(crate) struct SandboxHandle {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl SandboxHandle {
    /// 按策略创建 Job Object。
    ///
    /// 任一限制写入失败都返回 Err（句柄已回收）；调用方按插件来源档位决定 fail-closed 还是降级。
    pub(crate) fn create_with_policy(policy: &SandboxPolicy) -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::*;

        // 限制 flags：kill-on-close + die-on-unhandled-exception。
        // 不设 BREAKAWAY_OK → 子进程无法逃逸 Job。
        const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0000_0008;
        const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
        const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0000_0400;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
        const JOB_OBJECT_CPU_RATE_CONTROL_ENABLE: u32 = 0x0000_0001;
        const JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP: u32 = 0x0000_0004;

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "CreateJobObjectW 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        // 之后任一步失败都要回收句柄，避免泄漏。
        let guard = SandboxHandle { handle };

        // ① 基础限制 + 资源配额。
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut limit_flags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if policy.active_process_limit > 0 {
            limit_flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = policy.active_process_limit;
        }
        if policy.process_memory_limit > 0 {
            limit_flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit = policy.process_memory_limit as usize;
        }
        info.BasicLimitInformation.LimitFlags = limit_flags;

        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if result == 0 {
            return Err(format!(
                "SetInformationJobObject(ExtendedLimit) 失败：{}",
                std::io::Error::last_os_error()
            ));
        }

        // ② UI 限制。
        if policy.ui_restrictions != 0 {
            let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                UIRestrictionsClass: policy.ui_restrictions,
            };
            let result = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectBasicUIRestrictions,
                    &ui as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                )
            };
            if result == 0 {
                return Err(format!(
                    "SetInformationJobObject(UIRestrictions) 失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
        }

        // ③ CPU 硬上限（Windows 8+ API；Tauri 2 最低要求 Win10，可直接依赖）。
        if policy.cpu_rate > 0 {
            let mut cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = unsafe { std::mem::zeroed() };
            cpu.ControlFlags =
                JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
            cpu.Anonymous.CpuRate = policy.cpu_rate;
            let result = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectCpuRateControlInformation,
                    &cpu as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
                )
            };
            if result == 0 {
                return Err(format!(
                    "SetInformationJobObject(CpuRateControl) 失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
        }

        Ok(guard)
    }

    /// 把子进程分配到 Job Object。
    ///
    /// 由 `guarded_spawn` 在进程仍处 `CREATE_SUSPENDED` 挂起态时调用：进程尚未执行任何
    /// 用户代码，此时入 Job 可确保它后续 spawn 的孙进程也必然归入同一 Job（无逃逸窗口）。
    /// null 句柄时 no-op（降级模式：沙箱创建失败时不阻断启动）。
    pub(crate) fn assign_process(&self, child: &Child) -> Result<(), String> {
        if self.handle.is_null() {
            return Ok(());
        }
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let process_handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        let result = unsafe { AssignProcessToJobObject(self.handle, process_handle) };
        if result == 0 {
            return Err(format!(
                "AssignProcessToJobObject 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Default for SandboxHandle {
    /// 降级用空句柄：Drop 和 assign_process 对 null 句柄 no-op。
    fn default() -> Self {
        SandboxHandle {
            handle: std::ptr::null_mut(),
        }
    }
}

// SAFETY: SandboxHandle 仅持有 Windows Job Object 句柄（OS 资源标识符，非 Rust 内存指针）。
// 所有访问都通过 PluginProcessTable 的 Mutex 保护，Windows API（AssignProcessToJobObject /
// CloseHandle）本身线程安全。故 Send + Sync 安全。
#[cfg(windows)]
unsafe impl Send for SandboxHandle {}

#[cfg(windows)]
unsafe impl Sync for SandboxHandle {}

#[cfg(windows)]
impl Drop for SandboxHandle {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        // 关闭 Job 句柄 → 触发 KILL_ON_JOB_CLOSE → 整棵进程树被杀。
        // 即使 kill_child_tree 漏杀孙进程，这里也是安全网。
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe { CloseHandle(self.handle) };
    }
}

// ── Unix stub（沙箱未实现，见模块头注释与 P1-3 Step 5）──────────────

#[cfg(not(windows))]
pub(crate) struct SandboxHandle;

#[cfg(not(windows))]
impl Default for SandboxHandle {
    fn default() -> Self {
        SandboxHandle
    }
}

// ── 单元测试 ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::*;
    #[cfg(windows)]
    use crate::process_util::guarded_spawn::{SandboxPolicy, SandboxTier};

    #[test]
    #[cfg(windows)]
    fn sandbox_create_and_drop_does_not_leak() {
        // 创建 Job Object → 立即 drop：验证句柄可正常创建和关闭，不泄漏。
        let policy = SandboxPolicy::plugin_entry(SandboxTier::Builtin);
        let handle = SandboxHandle::create_with_policy(&policy).expect("创建 Job Object 应成功");
        drop(handle);
        // Drop 后句柄已关闭，无泄漏（KILL_ON_JOB_CLOSE 对空 Job 无副作用）。
    }

    #[test]
    #[cfg(windows)]
    fn sandbox_create_applies_all_limit_classes() {
        // 三组限制（扩展限制/UI/CPU 率）任一写入失败都会返回 Err，能建成即证明全部生效。
        let policy = SandboxPolicy::plugin_entry(SandboxTier::UserInstalled);
        assert!(policy.ui_restrictions != 0 && policy.cpu_rate != 0);
        let handle = SandboxHandle::create_with_policy(&policy).expect("三组限制都应写入成功");
        assert!(!handle.handle.is_null());
    }

    #[test]
    #[cfg(windows)]
    fn null_handle_assign_is_noop() {
        // 降级模式（空句柄）下 assign_process 必须静默成功，不能阻断启动。
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .expect("测试进程应能 spawn");
        assert!(SandboxHandle::default().assign_process(&child).is_ok());
        let _ = child.wait();
    }
}
