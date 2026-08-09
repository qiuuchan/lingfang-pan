use std::process::Child;

// `Command`/`Stdio` 仅用于 Unix 分支的 `kill -TERM/-KILL`；Windows 走 `windows_sys`，不引用它们。
// `CommandExt` 原先仅供 `prepare_process_group`（已并入 guarded_spawn）使用，移除该封装后不再需要。
#[cfg(unix)]
use std::process::{Command, Stdio};

pub(crate) fn kill_child_tree(child: &Child) {
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg("--")
            .arg(&group)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg("--")
            .arg(&group)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        kill_process_tree_windows(child.id());
    }
}

// 注：`prepare_process_group`（原 CREATE_NEW_PROCESS_GROUP / CREATE_NO_WINDOW / setsid 封装）
// 已被 `guarded_spawn::GuardedCommand` 统一吸收（P1-3 Step 0），此处不再保留。

#[cfg(unix)]
pub(super) fn libc_setsid() {
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe {
        let _ = setsid();
    }
}

#[cfg(windows)]
fn kill_process_tree_windows(pid: u32) {
    let child_pids = windows_child_pids(pid);
    for child_pid in child_pids {
        kill_process_tree_windows(child_pid);
    }
    terminate_windows_process(pid);
}

#[cfg(windows)]
fn windows_child_pids(parent_pid: u32) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }

    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    let mut child_pids = Vec::new();
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;

    while has_entry {
        if entry.th32ParentProcessID == parent_pid {
            child_pids.push(entry.th32ProcessID);
        }
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }

    unsafe {
        CloseHandle(snapshot);
    }
    child_pids
}

#[cfg(windows)]
fn terminate_windows_process(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        return;
    }

    unsafe {
        let _ = TerminateProcess(handle, 1);
        CloseHandle(handle);
    }
}
