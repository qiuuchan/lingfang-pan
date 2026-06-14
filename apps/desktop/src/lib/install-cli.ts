// install-cli.ts — CLI/运行时自动安装的 invoke 封装与事件常量。
//
// 职责：
// - 封装桌面壳 install_cli / install_runtime / cancel_install 三个 Tauri 命令。
// - 暴露事件名常量（install-cli://done / code-assistant://availability-changed）供 Settings 顶层监听。
// - 提供安装目标的展示元数据（名称、winget 包 id 提示文案），与 Rust winget_package_id 镜像。
//
// 安全：install_cli/install_runtime 是「用户主动触发的包管理器执行」通道（高权限操作），
// Rust 侧已做 winget id 白名单 + env_clear 裁宿主 token + 输出 redact + 半装清理（见 cli_installer.rs 顶部注释）。
// 前端职责仅是调用 + 二次确认 Dialog（design B17）。

import { tauriInvoke } from '@/lib/api';
import type {
  CliInstallTarget,
  InstallResult,
  RuntimeInstallTarget,
} from '@/lib/cli-types';

/** 安装完成事件（Rust emit，每次 install 结束发一次，含 target + 终态）。 */
export const INSTALL_DONE_EVENT = 'install-cli://done';

/** 可用性变更事件（Rust emit，安装成功后发全量 Vec<ToolAvailability>，与 main.rs:232 首启同形态）。 */
export const AVAILABILITY_EVENT = 'code-assistant://availability-changed';

/**
 * 安装 CLI 工具（claude/codex/opencode）。走 winget（仅 Windows）。
 * 非阻塞返回（首版非流式，design B7），300s 硬超时由 Rust 兜底。
 * 成功后 Rust 自动 emit AVAILABILITY_EVENT，前端监听即可刷新探测，无需手动重探。
 *
 * 入参契约：Rust 命令签名为 `install_cli(app, input: InstallInput)`，
 * 与项目其他命令（code_assistant_*）一致走 struct 入参，前端必须包 `{ input: {...} }`，
 * 否则 Tauri 报 `missing required key input`。
 */
export function installCli(target: CliInstallTarget) {
  return tauriInvoke<InstallResult>('install_cli', { input: { target } });
}

/**
 * 安装运行时（nodejs/python）。走 winget（仅 Windows）。
 * 语义同 installCli，入参契约同样包 `{ input: {...} }`。
 */
export function installRuntime(target: RuntimeInstallTarget) {
  return tauriInvoke<InstallResult>('install_runtime', { input: { target } });
}

/**
 * 取消正在进行的安装。Rust 侧杀进程组（复用 kill_child_tree）。
 * 首版 cancel 靠 300s 超时兜底（cli_installer CURRENT_INSTALL 占位），真打断留 TODO。
 * 入参契约同样包 `{ input: {...} }`。
 */
export function cancelInstall(target: CliInstallTarget | RuntimeInstallTarget) {
  return tauriInvoke<null>('cancel_install', { input: { target } });
}

/** CLI 工具展示元数据（名称 + winget 包 id 提示）。与 Rust winget_package_id 镜像，仅供 UI 展示。 */
export const CLI_TOOL_META: Record<CliInstallTarget, { label: string; wingetId: string }> = {
  claude: { label: 'Claude Code', wingetId: 'Anthropic.ClaudeCode' },
  codex: { label: 'Codex', wingetId: 'OpenAI.Codex' },
  opencode: { label: 'opencode', wingetId: 'SST.opencode' },
};

/** 运行时展示元数据。与 Rust winget_package_id 镜像。 */
export const RUNTIME_META: Record<RuntimeInstallTarget, { label: string; wingetId: string }> = {
  nodejs: { label: 'Node.js', wingetId: 'OpenJS.NodeJS.LTS' },
  python: { label: 'Python', wingetId: 'Python.Python.3.12' },
};
