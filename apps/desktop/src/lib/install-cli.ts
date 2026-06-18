// install-cli.ts — 脚本运行时自动安装的 invoke 封装与事件常量。
//
// 职责：
// - 封装桌面壳 install_runtime / cancel_install 两个 Tauri 命令。
// - 提供安装目标的展示元数据（名称、winget 包 id 提示文案），与 Rust winget_package_id 镜像。
//
// 安全：install_runtime 是「用户主动触发的包管理器执行」通道（高权限操作），
// Rust 侧已做 winget id 白名单 + env_clear 裁宿主 token + 输出 redact + 半装清理（见 cli_installer.rs 顶部注释）。
// 前端职责仅是调用 + 二次确认 Dialog（design B17）。

import { tauriInvoke } from '@/lib/api';
import type { InstallResult, RuntimeInstallTarget } from '@/lib/cli-types';

/**
 * 安装运行时（nodejs/python）。走 winget（仅 Windows）。
 * 入参契约包 `{ input: {...} }`。
 */
export function installRuntime(target: RuntimeInstallTarget) {
  return tauriInvoke<InstallResult>('install_runtime', { input: { target } });
}

/**
 * 取消正在进行的安装。Rust 侧杀进程组（复用 kill_child_tree）。
 * 首版 cancel 靠 300s 超时兜底（cli_installer CURRENT_INSTALL 占位），真打断留 TODO。
 * 入参契约同样包 `{ input: {...} }`。
 */
export function cancelInstall(target: RuntimeInstallTarget) {
  return tauriInvoke<null>('cancel_install', { input: { target } });
}

/** 运行时展示元数据。与 Rust winget_package_id 镜像。 */
export const RUNTIME_META: Record<RuntimeInstallTarget, { label: string; wingetId: string }> = {
  nodejs: { label: 'Node.js', wingetId: 'OpenJS.NodeJS.LTS' },
  python: { label: 'Python', wingetId: 'Python.Python.3.12' },
};
