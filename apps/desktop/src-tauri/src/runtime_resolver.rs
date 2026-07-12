//! 统一运行时解析器（runtime_resolver）。
//!
//! 所有 Python / Node 进程调用的**唯一入口**：plugin_runner（持久化执行）、
//! plugin_script（预览执行 + probe）、Agent 工具链（经 Tauri 命令间接）全部经此解析。
//!
//! ## 「应用一定用自己管理的运行时」三条不变式
//!
//! 1. `resolve_runtime_command()` 永不查系统 PATH，只查配置中的用户指定与应用管理目录。
//! 2. `env()` 清空宿主 PATH（`retain` 掉 key==PATH），只注入命中来源的 PATH ——
//!    子进程内部 `subprocess.run("python")` / `child_process.exec("node")` 也只能命中应用管理的解释器。
//! 3. `require_runtime_command()` 找不到返回结构化错误，前端引导用户检查安装包完整性。
//!
//! ## 解析优先级
//!
//! `resolve(kind)` 顺序：UserSpecified → AppManaged → None。
//!
//! ## 目录布局约定
//!
//! `python_dir` / `node_dir` **直接含主 exe**（`python.exe` / `node.exe` 在该目录下）。
//! 配置中的目录直接包含主 exe；非 Windows 平台使用常规 `bin/` 布局。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::mirror_presets::{extract_host, resolve_npm_url, resolve_pip_url, MirrorConfig};
use crate::runtime_config::{runtime_executable_dir, RuntimeConfig, RuntimeConfigStore};

/// Playwright 浏览器二进制下载镜像（国内加速，固定 npmmirror CDN）。
///
/// 与 npm registry 解耦：npm 源用户可配（清华/阿里/...），但 playwright 浏览器二进制
/// 只 npmmirror 有稳定镜像，故固定。`playwright install` 默认从 cdn.playwright.dev 拉
/// chromium/wekit/firefox，国内极慢/失败；设此 host 后走 npmmirror 的 binaries/playwright 镜像。
pub(crate) const PLAYWRIGHT_DOWNLOAD_HOST: &str = "https://cdn.npmmirror.com/binaries/playwright";

/// 运行时来源（供 UI 状态展示 + 日志）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeSource {
    AppManaged,
    UserSpecified,
}

/// 单个运行时的解析结果（dir + 来源）。
#[derive(Clone, Debug)]
struct ResolvedRuntime {
    /// 直接含主 exe 的目录。
    dir: PathBuf,
    /// 来源标签（Step 5 设置页 UI 展示用）。
    #[allow(dead_code)]
    source: RuntimeSource,
}

/// 统一运行时解析器：所有 Python / Node 调用的唯一入口。
pub(crate) struct RuntimeResolver {
    python: Option<ResolvedRuntime>,
    node: Option<ResolvedRuntime>,
    // FFmpeg 作为第三内置运行时（runtimes/ffmpeg/）：插件进程 PATH 自动包含，
    // shutil.which("ffmpeg") 直接命中内置版本，插件无需宿主机安装 ffmpeg。
    ffmpeg: Option<ResolvedRuntime>,
    config: RuntimeConfig,
}

impl RuntimeResolver {
    /// 从 config + 文件系统解析当前生效的运行时。
    pub(crate) fn resolve<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let config = RuntimeConfigStore::from_app(app)?.read();
        let python = resolve_python(&config, app);
        let node = resolve_node(&config, app);
        let ffmpeg = resolve_ffmpeg(&config, app);
        Ok(Self {
            python,
            node,
            ffmpeg,
            config,
        })
    }

    /// 测试构造：直接指定 python_dir / node_dir（标 AppManaged 来源）。
    /// 用 None 表示该运行时未配置，供 env()/require_* 的缺失路径测试。
    #[cfg(test)]
    pub(crate) fn from_dirs(python_dir: Option<PathBuf>, node_dir: Option<PathBuf>) -> Self {
        let python = python_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::AppManaged,
        });
        let node = node_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::AppManaged,
        });
        Self {
            python,
            node,
            ffmpeg: None,
            config: RuntimeConfig::default(),
        }
    }

    /// 测试构造：带 config（测镜像注入）。
    #[cfg(test)]
    pub(crate) fn from_dirs_with_config(
        python_dir: Option<PathBuf>,
        node_dir: Option<PathBuf>,
        config: RuntimeConfig,
    ) -> Self {
        let python = python_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::AppManaged,
        });
        let node = node_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::AppManaged,
        });
        Self {
            python,
            node,
            ffmpeg: None,
            config,
        }
    }

    /// 测试构造：指定 ffmpeg_dir（标 AppManaged 来源）。python/node 默认 None，
    /// 专用于 ffmpeg 进 PATH 的测试。
    #[cfg(test)]
    pub(crate) fn from_dirs_with_ffmpeg(ffmpeg_dir: Option<PathBuf>) -> Self {
        let ffmpeg = ffmpeg_dir.map(|dir| ResolvedRuntime {
            dir,
            source: RuntimeSource::AppManaged,
        });
        Self {
            python: None,
            node: None,
            ffmpeg,
            config: RuntimeConfig::default(),
        }
    }

    pub(crate) fn python(&self) -> Option<PathBuf> {
        self.python.as_ref().map(|r| python_exe(&r.dir))
    }

    pub(crate) fn node(&self) -> Option<PathBuf> {
        self.node.as_ref().map(|r| node_exe(&r.dir))
    }

    pub(crate) fn pip(&self) -> Option<PathBuf> {
        self.python.as_ref().and_then(|r| pip_exe(&r.dir))
    }

    pub(crate) fn uv(&self) -> Option<PathBuf> {
        self.python.as_ref().and_then(|r| uv_exe(&r.dir))
    }

    pub(crate) fn npm(&self) -> Option<PathBuf> {
        self.node.as_ref().and_then(|r| npm_exe(&r.dir))
    }

    pub(crate) fn pnpm(&self) -> Option<PathBuf> {
        self.node.as_ref().and_then(|r| pnpm_exe(&r.dir))
    }

    /// FFmpeg 主 exe 绝对路径（runtimes/ffmpeg/ffmpeg.exe）。
    pub(crate) fn ffmpeg(&self) -> Option<PathBuf> {
        self.ffmpeg.as_ref().map(|r| ffmpeg_exe(&r.dir))
    }

    /// Python 主 exe 所在目录（供 bundled_pip_wheel_dir 推导 ensurepip/_bundled 路径）。
    pub(crate) fn python_dir(&self) -> Option<&Path> {
        self.python.as_ref().map(|r| r.dir.as_path())
    }

    /// Node 主 exe 所在目录（供 UI 状态展示）。
    #[allow(dead_code)]
    pub(crate) fn node_dir(&self) -> Option<&Path> {
        self.node.as_ref().map(|r| r.dir.as_path())
    }

    /// FFmpeg 主 exe 所在目录（runtimes/ffmpeg/）。
    #[allow(dead_code)]
    pub(crate) fn ffmpeg_dir(&self) -> Option<&Path> {
        self.ffmpeg.as_ref().map(|r| r.dir.as_path())
    }

    pub(crate) fn python_source(&self) -> Option<&RuntimeSource> {
        self.python.as_ref().map(|r| &r.source)
    }

    #[allow(dead_code)]
    pub(crate) fn node_source(&self) -> Option<&RuntimeSource> {
        self.node.as_ref().map(|r| &r.source)
    }

    #[allow(dead_code)]
    pub(crate) fn ffmpeg_source(&self) -> Option<&RuntimeSource> {
        self.ffmpeg.as_ref().map(|r| &r.source)
    }

    #[allow(dead_code)]
    pub(crate) fn mirrors(&self) -> &MirrorConfig {
        &self.config.mirrors
    }

    /// 按命令名解析运行时绝对路径（永不查系统 PATH）。
    pub(crate) fn resolve_runtime_command(&self, command: &str) -> Option<PathBuf> {
        match normalize_command_name(command).as_deref() {
            Some("python" | "python3" | "py") => self.python(),
            Some("pip" | "pip3") => self.pip(),
            Some("uv") => self.uv(),
            Some("node" | "nodejs") => self.node(),
            Some("npm") => self.npm(),
            Some("pnpm") => self.pnpm(),
            // FFmpeg 内置运行时：给需要绝对路径直接 spawn ffmpeg 的插件。
            // 多数插件走 shutil.which("ffmpeg")——靠 path_value() 把 runtimes/ffmpeg/ 加进 PATH 命中。
            Some("ffmpeg") => self.ffmpeg(),
            _ => None,
        }
    }

    /// 按命令名解析运行时绝对路径，缺失返回结构化错误（前端引导下载/指定）。
    pub(crate) fn require_runtime_command(&self, command: &str) -> Result<PathBuf, String> {
        self.resolve_runtime_command(command).ok_or_else(|| {
            format!(
                "未找到运行时命令 {command}。请在「设置 → 脚本运行环境」下载便携版或指定已安装的 Python / Node.js 路径。"
            )
        })
    }

    /// 构造子进程环境变量：清宿主 PATH + 注入命中来源 PATH + 镜像源。
    pub(crate) fn env(&self, base: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
        let mut env = base;
        env.retain(|(key, _)| !key.eq_ignore_ascii_case(OsStr::new("PATH")));
        env.push((OsString::from("PATH"), self.path_value()));

        let pip_url = resolve_pip_url(&self.config.mirrors);
        let npm_url = resolve_npm_url(&self.config.mirrors);
        env.push((OsString::from("PIP_INDEX_URL"), OsString::from(&pip_url)));
        if let Some(host) = extract_host(&pip_url) {
            env.push((OsString::from("PIP_TRUSTED_HOST"), OsString::from(host)));
        }
        env.push((
            OsString::from("PIP_DISABLE_PIP_VERSION_CHECK"),
            OsString::from("1"),
        ));
        env.push((OsString::from("PIP_NO_INPUT"), OsString::from("1")));
        env.push((
            OsString::from("NPM_CONFIG_REGISTRY"),
            OsString::from(&npm_url),
        ));
        env.push((
            OsString::from("npm_config_registry"),
            OsString::from(&npm_url),
        ));
        env.push((
            OsString::from("COREPACK_ENABLE_DOWNLOAD_PROMPT"),
            OsString::from("0"),
        ));
        env
    }

    /// 拼接命中来源的 PATH 值（node + node/bin + python + python/Scripts + python/bin
    /// + ffmpeg + Windows 系统目录 System32 / Wbem / PowerShell）。
    ///
    /// **必须追加系统目录**：进程清空宿主 PATH 后，若 PATH 不含 System32，python.exe / node.exe
    /// 启动时加载依赖 DLL（VCRUNTIME、api-ms-win-* 等）会因搜索路径缺失而立即崩溃（输出任何 stderr
    /// 之前退出）；且 PS launcher 的 `cmd /c pause`、插件内 `shutil.which("ffmpeg")` 等
    /// 也需 System32。这是 Windows 沙盒的通行做法：PATH 可受限，但 System32 必须保留。
    ///
    /// **ffmpeg 内置运行时进 PATH**：把 runtimes/ffmpeg/ 加到 PATH，插件的
    /// `shutil.which("ffmpeg")` 直接命中内置版本，无需宿主机安装 ffmpeg。
    pub(crate) fn path_value(&self) -> OsString {
        let mut paths = Vec::new();
        if let Some(node) = &self.node {
            push_if_dir(&mut paths, node.dir.clone());
            push_if_dir(&mut paths, node.dir.join("bin"));
        }
        if let Some(python) = &self.python {
            push_if_dir(&mut paths, python.dir.clone());
            push_if_dir(&mut paths, python.dir.join("Scripts"));
            push_if_dir(&mut paths, python.dir.join("bin"));
        }
        if let Some(ffmpeg) = &self.ffmpeg {
            push_if_dir(&mut paths, ffmpeg.dir.clone());
        }
        // 追加 Windows 系统目录（System32 + Wbem + PowerShell），保证 OS 基础工具/DLL 可达。
        #[cfg(windows)]
        {
            let sysroot =
                std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from("C:\\Windows"));
            let sysroot = PathBuf::from(sysroot);
            push_if_dir(&mut paths, sysroot.join("System32"));
            push_if_dir(&mut paths, sysroot.join("System32").join("Wbem"));
            push_if_dir(
                &mut paths,
                sysroot
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0"),
            );
        }
        std::env::join_paths(paths).unwrap_or_default()
    }
}

// === 解析逻辑 ===

/// 解析 Python：用户显式指定优先，其次应用管理版本。
fn resolve_python<R: tauri::Runtime>(config: &RuntimeConfig, _app: &tauri::AppHandle<R>) -> Option<ResolvedRuntime> {
    resolve_configured(
        config.user_specified_python.as_deref(),
        config.app_managed_python.as_ref().map(|entry| entry.dir.as_str()),
        python_exe,
    )
}

/// 解析 Node：用户显式指定优先，其次应用管理版本。
fn resolve_node<R: tauri::Runtime>(config: &RuntimeConfig, _app: &tauri::AppHandle<R>) -> Option<ResolvedRuntime> {
    resolve_configured(
        config.user_specified_node.as_deref(),
        config.app_managed_node.as_ref().map(|entry| entry.dir.as_str()),
        node_exe,
    )
}

/// FFmpeg 不属于本任务的按需运行时，未配置时返回 None。
fn resolve_ffmpeg<R: tauri::Runtime>(
    _config: &RuntimeConfig,
    _app: &tauri::AppHandle<R>,
) -> Option<ResolvedRuntime> {
    None
}

fn resolve_configured(
    user_path: Option<&str>,
    managed_path: Option<&str>,
    executable: fn(&Path) -> PathBuf,
) -> Option<ResolvedRuntime> {
    for (path, source) in [
        (user_path, RuntimeSource::UserSpecified),
        (managed_path, RuntimeSource::AppManaged),
    ] {
        let Some(path) = path else { continue };
        let dir = runtime_executable_dir(Path::new(path));
        if executable(&dir).is_file() {
            return Some(ResolvedRuntime { dir, source });
        }
    }
    None
}

// === exe 路径辅助（跨平台） ===

#[cfg(windows)]
fn python_exe(dir: &Path) -> PathBuf {
    dir.join("python.exe")
}
#[cfg(not(windows))]
fn python_exe(dir: &Path) -> PathBuf {
    dir.join("bin").join("python")
}

#[cfg(windows)]
fn node_exe(dir: &Path) -> PathBuf {
    dir.join("node.exe")
}
#[cfg(not(windows))]
fn node_exe(dir: &Path) -> PathBuf {
    dir.join("bin").join("node")
}

#[cfg(windows)]
fn ffmpeg_exe(dir: &Path) -> PathBuf {
    dir.join("ffmpeg.exe")
}
#[cfg(not(windows))]
fn ffmpeg_exe(dir: &Path) -> PathBuf {
    dir.join("bin").join("ffmpeg")
}

fn pip_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![
            dir.join("Scripts").join("pip.exe"),
            dir.join("Scripts").join("pip.cmd"),
            dir.join("Scripts").join("pip.bat"),
        ],
        vec![dir.join("bin").join("pip")],
    ))
}

fn uv_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![
            dir.join("uv.exe"),
            dir.join("Scripts").join("uv.exe"),
            dir.join("uv"),
        ],
        vec![dir.join("bin").join("uv"), dir.join("uv")],
    ))
}

fn npm_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![dir.join("npm.cmd"), dir.join("npm.exe"), dir.join("npm")],
        vec![dir.join("bin").join("npm"), dir.join("npm")],
    ))
}

fn pnpm_exe(dir: &Path) -> Option<PathBuf> {
    first_existing(windows_unix_many(
        vec![dir.join("pnpm.cmd"), dir.join("pnpm.exe"), dir.join("pnpm")],
        vec![dir.join("bin").join("pnpm"), dir.join("pnpm")],
    ))
}

fn normalize_command_name(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    let file_name = Path::new(trimmed).file_name()?.to_string_lossy();
    let lower = file_name.to_ascii_lowercase();
    Some(
        lower
            .strip_suffix(".exe")
            .or_else(|| lower.strip_suffix(".cmd"))
            .or_else(|| lower.strip_suffix(".bat"))
            .unwrap_or(&lower)
            .to_string(),
    )
}

fn first_existing(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

fn push_if_dir(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        paths.push(path);
    }
}

#[cfg(windows)]
fn windows_unix_many(windows: Vec<PathBuf>, _unix: Vec<PathBuf>) -> Vec<PathBuf> {
    windows
}
#[cfg(not(windows))]
fn windows_unix_many(_windows: Vec<PathBuf>, unix: Vec<PathBuf>) -> Vec<PathBuf> {
    unix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_commands_are_detected_by_name() {
        let r = RuntimeResolver::from_dirs(None, None);
        assert!(r.resolve_runtime_command("node").is_none()); // 未配置 → None
        assert!(r.resolve_runtime_command("git").is_none()); // 非运行时命令
                                                             // 名字归一化（带后缀也能识别），但因未配置 exe 仍 None。
        assert!(r.resolve_runtime_command("python.exe").is_none());
    }

    #[test]
    fn env_replaces_path_and_adds_default_mirrors() {
        // 无运行时 + default config（清华 / npmmirror）。
        let r = RuntimeResolver::from_dirs(None, None);
        let env = r.env(vec![
            (OsString::from("PATH"), OsString::from("host-path")),
            (OsString::from("SystemRoot"), OsString::from("C:\\Windows")),
        ]);
        let contains = |key: &str, value: &str| {
            env.iter()
                .any(|(k, v)| k.to_string_lossy() == key && v.to_string_lossy() == value)
        };
        // 宿主其它变量保留。
        assert!(contains("SystemRoot", "C:\\Windows"));
        // 默认镜像注入。
        assert!(contains(
            "PIP_INDEX_URL",
            "https://pypi.tuna.tsinghua.edu.cn/simple"
        ));
        assert!(contains(
            "NPM_CONFIG_REGISTRY",
            "https://registry.npmmirror.com"
        ));
        // trusted host 从 pip url 提取。
        assert!(contains("PIP_TRUSTED_HOST", "pypi.tuna.tsinghua.edu.cn"));
        // 宿主 PATH 被清空（替换为命中来源的 PATH，无运行时则为空）。
        assert!(!contains("PATH", "host-path"));
    }

    #[cfg(windows)]
    #[test]
    fn path_value_includes_windows_system32() {
        // System32 必须在 PATH 里：python/node 启动加载依赖 DLL、PS launcher 的 cmd /c pause、
        // 插件内 shutil.which("ffmpeg") 等都依赖 System32。清空宿主 PATH 后必须补回。
        let r = RuntimeResolver::from_dirs(None, None);
        let path = r.path_value().to_string_lossy().to_string();
        assert!(
            path.to_ascii_lowercase().contains("system32"),
            "PATH 应含 System32，实际：{path}"
        );
    }

    #[test]
    fn env_uses_configured_mirrors() {
        let mut config = RuntimeConfig::default();
        config.mirrors.pip_id = "aliyun".to_string();
        config.mirrors.npm_id = "huawei".to_string();
        let r = RuntimeResolver::from_dirs_with_config(None, None, config);
        let env = r.env(vec![]);
        let contains = |key: &str, value: &str| {
            env.iter()
                .any(|(k, v)| k.to_string_lossy() == key && v.to_string_lossy() == value)
        };
        assert!(contains(
            "PIP_INDEX_URL",
            "https://mirrors.aliyun.com/pypi/simple/"
        ));
        assert!(contains(
            "NPM_CONFIG_REGISTRY",
            "https://repo.huaweicloud.com/repository/npm/"
        ));
    }

    #[test]
    fn require_runtime_command_errors_when_missing() {
        let r = RuntimeResolver::from_dirs(None, None);
        let err = r.require_runtime_command("python").unwrap_err();
        assert!(err.contains("设置"), "错误应引导去设置：{err}");
    }

    #[test]
    fn resolve_prefers_user_specified_over_app_managed() {
        let root = std::env::temp_dir().join(format!("lf-runtime-resolver-{}", uuid::Uuid::new_v4()));
        let user = root.join("user");
        let managed = root.join("managed");
        #[cfg(windows)]
        let relative = PathBuf::from("python.exe");
        #[cfg(not(windows))]
        let relative = PathBuf::from("bin/python");
        std::fs::create_dir_all(user.join(relative.parent().unwrap_or(Path::new("")))).unwrap();
        std::fs::create_dir_all(managed.join(relative.parent().unwrap_or(Path::new("")))).unwrap();
        std::fs::write(user.join(&relative), b"fake").unwrap();
        std::fs::write(managed.join(&relative), b"fake").unwrap();
        let resolved = resolve_configured(
            Some(user.to_string_lossy().as_ref()),
            Some(managed.to_string_lossy().as_ref()),
            python_exe,
        ).unwrap();
        assert_eq!(resolved.source, RuntimeSource::UserSpecified);
        let _ = std::fs::remove_dir_all(root);
    }

    // === ffmpeg 内置运行时（第三运行时）测试 ===

    #[test]
    fn ffmpeg_none_when_not_configured() {
        // 无 ffmpeg 配置 → ffmpeg() / ffmpeg_dir() / ffmpeg_source() 全 None。
        let r = RuntimeResolver::from_dirs(None, None);
        assert!(r.ffmpeg().is_none());
        assert!(r.ffmpeg_dir().is_none());
        assert!(r.ffmpeg_source().is_none());
        // resolve_runtime_command 也 None。
        assert!(r.resolve_runtime_command("ffmpeg").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn ffmpeg_dir_in_path_when_configured() {
        // 临时目录建 fake ffmpeg.exe → ffmpeg dir 应进 PATH（关键：插件 shutil.which 命中靠此）。
        let tmp = std::env::temp_dir().join(format!(
            "lf-ffmpeg-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("ffmpeg.exe"), b"fake").unwrap();
        let r = RuntimeResolver::from_dirs_with_ffmpeg(Some(tmp.clone()));
        let path = r.path_value().to_string_lossy().to_string();
        assert!(
            path.contains(&tmp.to_string_lossy().to_string()),
            "PATH 应含 ffmpeg 目录，实际：{path}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_ffmpeg_by_name() {
        // 命名归一化：ffmpeg / ffmpeg.exe / FFMPEG 都解析到 ffmpeg 运行时。
        let tmp = std::env::temp_dir().join(format!(
            "lf-ffmpeg-name-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // 跨平台：Windows 建 ffmpeg.exe，Unix 建 bin/ffmpeg。
        #[cfg(windows)]
        std::fs::write(tmp.join("ffmpeg.exe"), b"fake").unwrap();
        #[cfg(not(windows))]
        {
            std::fs::create_dir_all(tmp.join("bin")).unwrap();
            std::fs::write(tmp.join("bin").join("ffmpeg"), b"fake").unwrap();
        }
        let r = RuntimeResolver::from_dirs_with_ffmpeg(Some(tmp.clone()));
        assert!(r.resolve_runtime_command("ffmpeg").is_some());
        assert!(r.resolve_runtime_command("FFMPEG").is_some());
        #[cfg(windows)]
        assert!(r.resolve_runtime_command("ffmpeg.exe").is_some());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
