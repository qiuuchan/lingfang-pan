mod binary;
mod capture;
mod tree;

#[cfg(test)]
pub(crate) use binary::find_binaries_in_path;
#[cfg(all(windows, test))]
pub(crate) use binary::resolve_npm_shim;
#[cfg(test)]
pub(crate) use binary::command_preview;
pub(crate) use binary::{find_binaries, find_binary};
pub(crate) use capture::{run_capture_with_env, CapturedOutput};
pub(crate) use tree::kill_child_tree;
