use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use tauri::Manager;

pub(crate) const PIP_INDEX_URL: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";
pub(crate) const PIP_TRUSTED_HOST: &str = "pypi.tuna.tsinghua.edu.cn";
pub(crate) const NPM_REGISTRY: &str = "https://registry.npmmirror.com";

#[derive(Clone, Debug)]
pub(crate) struct EmbeddedRuntime {
    root: PathBuf,
}

impl EmbeddedRuntime {
    pub(crate) fn from_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let root = if let Some(override_dir) = std::env::var_os("LINGFANG_EMBEDDED_RUNTIME_DIR") {
            PathBuf::from(override_dir)
        } else {
            app.path()
                .resource_dir()
                .map_err(|error| error.to_string())?
                .join("runtimes")
        };
        Ok(Self { root })
    }

    pub(crate) fn from_default_locations() -> Self {
        let root = if let Some(override_dir) = std::env::var_os("LINGFANG_EMBEDDED_RUNTIME_DIR") {
            PathBuf::from(override_dir)
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|path| path.join("runtimes"))
                .unwrap_or_else(|| PathBuf::from("runtimes"))
        };
        Self { root }
    }

    pub(crate) fn from_root(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn python(&self) -> Option<PathBuf> {
        first_existing(windows_unix(
            self.root.join("python").join("python.exe"),
            self.root.join("python").join("bin").join("python"),
        ))
    }

    pub(crate) fn node(&self) -> Option<PathBuf> {
        first_existing(windows_unix(
            self.root.join("nodejs").join("node.exe"),
            self.root.join("nodejs").join("bin").join("node"),
        ))
    }

    pub(crate) fn npm(&self) -> Option<PathBuf> {
        first_existing(windows_unix_many(
            vec![
                self.root.join("nodejs").join("npm.cmd"),
                self.root.join("nodejs").join("npm.exe"),
                self.root.join("nodejs").join("npm"),
            ],
            vec![
                self.root.join("nodejs").join("bin").join("npm"),
                self.root.join("nodejs").join("npm"),
            ],
        ))
    }

    pub(crate) fn pnpm(&self) -> Option<PathBuf> {
        first_existing(windows_unix_many(
            vec![
                self.root.join("nodejs").join("pnpm.cmd"),
                self.root.join("nodejs").join("pnpm.exe"),
                self.root.join("nodejs").join("pnpm"),
            ],
            vec![
                self.root.join("nodejs").join("bin").join("pnpm"),
                self.root.join("nodejs").join("pnpm"),
            ],
        ))
    }

    pub(crate) fn pip(&self) -> Option<PathBuf> {
        first_existing(windows_unix_many(
            vec![
                self.root.join("python").join("Scripts").join("pip.exe"),
                self.root.join("python").join("Scripts").join("pip.cmd"),
                self.root.join("python").join("Scripts").join("pip.bat"),
            ],
            vec![self.root.join("python").join("bin").join("pip")],
        ))
    }

    pub(crate) fn resolve_runtime_command(&self, command: &str) -> Option<PathBuf> {
        match normalize_command_name(command).as_deref() {
            Some("python" | "python3" | "py") => self.python(),
            Some("pip" | "pip3") => self.pip(),
            Some("node" | "nodejs") => self.node(),
            Some("npm") => self.npm(),
            Some("pnpm") => self.pnpm(),
            _ => None,
        }
    }

    pub(crate) fn require_runtime_command(&self, command: &str) -> Result<PathBuf, String> {
        self.resolve_runtime_command(command).ok_or_else(|| {
            format!(
                "未找到软件内置运行时命令：{command}。请确认 runtimes/python 与 runtimes/nodejs 已随应用打包。"
            )
        })
    }

    pub(crate) fn env(&self, base: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
        let mut env = base;
        env.retain(|(key, _)| !key.eq_ignore_ascii_case(OsStr::new("PATH")));
        env.push((OsString::from("PATH"), self.path_value()));
        env.push((
            OsString::from("PIP_INDEX_URL"),
            OsString::from(PIP_INDEX_URL),
        ));
        env.push((
            OsString::from("PIP_TRUSTED_HOST"),
            OsString::from(PIP_TRUSTED_HOST),
        ));
        env.push((
            OsString::from("PIP_DISABLE_PIP_VERSION_CHECK"),
            OsString::from("1"),
        ));
        env.push((OsString::from("PIP_NO_INPUT"), OsString::from("1")));
        env.push((
            OsString::from("NPM_CONFIG_REGISTRY"),
            OsString::from(NPM_REGISTRY),
        ));
        env.push((
            OsString::from("npm_config_registry"),
            OsString::from(NPM_REGISTRY),
        ));
        env.push((
            OsString::from("COREPACK_ENABLE_DOWNLOAD_PROMPT"),
            OsString::from("0"),
        ));
        env
    }

    pub(crate) fn path_value(&self) -> OsString {
        let mut paths = Vec::new();
        push_if_dir(&mut paths, self.root.join("nodejs"));
        push_if_dir(&mut paths, self.root.join("nodejs").join("bin"));
        push_if_dir(&mut paths, self.root.join("python"));
        push_if_dir(&mut paths, self.root.join("python").join("Scripts"));
        push_if_dir(&mut paths, self.root.join("python").join("bin"));
        std::env::join_paths(paths).unwrap_or_default()
    }
}

pub(crate) fn is_runtime_command(command: &str) -> bool {
    normalize_command_name(command)
        .map(|name| {
            matches!(
                name.as_str(),
                "python" | "python3" | "py" | "pip" | "pip3" | "node" | "nodejs" | "npm" | "pnpm"
            )
        })
        .unwrap_or(false)
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

#[cfg(windows)]
fn windows_unix(windows: PathBuf, _unix: PathBuf) -> Vec<PathBuf> {
    vec![windows]
}

#[cfg(not(windows))]
fn windows_unix(_windows: PathBuf, unix: PathBuf) -> Vec<PathBuf> {
    vec![unix]
}

#[cfg(windows)]
fn windows_unix_many(windows: Vec<PathBuf>, _unix: Vec<PathBuf>) -> Vec<PathBuf> {
    windows
}

#[cfg(not(windows))]
fn windows_unix_many(_windows: Vec<PathBuf>, unix: Vec<PathBuf>) -> Vec<PathBuf> {
    unix
}

fn push_if_dir(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        paths.push(path);
    }
}

trait OsStrEqIgnoreAsciiCase {
    fn eq_ignore_ascii_case(&self, other: &OsStr) -> bool;
}

impl OsStrEqIgnoreAsciiCase for OsString {
    fn eq_ignore_ascii_case(&self, other: &OsStr) -> bool {
        self.to_string_lossy()
            .eq_ignore_ascii_case(&other.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_commands_are_detected_by_name() {
        assert!(is_runtime_command("node"));
        assert!(is_runtime_command("C:/x/npm.cmd"));
        assert!(is_runtime_command("python.exe"));
        assert!(!is_runtime_command("git"));
    }

    #[test]
    fn env_replaces_path_and_adds_cn_mirrors() {
        let rt = EmbeddedRuntime::from_root(PathBuf::from("/missing"));
        let env = rt.env(vec![
            (OsString::from("PATH"), OsString::from("host-path")),
            (OsString::from("SystemRoot"), OsString::from("C:\\Windows")),
        ]);
        let contains = |key: &str, value: &str| {
            env.iter()
                .any(|(k, v)| k.to_string_lossy() == key && v.to_string_lossy() == value)
        };
        assert!(contains("SystemRoot", "C:\\Windows"));
        assert!(contains("PIP_INDEX_URL", PIP_INDEX_URL));
        assert!(contains("NPM_CONFIG_REGISTRY", NPM_REGISTRY));
        assert!(!contains("PATH", "host-path"));
    }
}
