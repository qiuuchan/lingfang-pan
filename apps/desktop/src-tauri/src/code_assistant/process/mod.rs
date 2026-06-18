mod binary;
mod capture;
mod tree;

#[cfg(test)]
pub(crate) use binary::find_binaries_in_path;
#[cfg(all(windows, test))]
pub(crate) use binary::resolve_npm_shim;
pub(crate) use binary::{build_spawn_command, command_preview, find_binaries, find_binary};
pub(crate) use capture::{run_capture, run_capture_with_env, CapturedOutput};
pub(crate) use tree::{kill_child_tree, prepare_process_group, stop_child_process};
