// cli-types.ts — 桌面脚本运行时探测/安装的类型定义。
//
// 职责：
// - 镜像 Rust 侧 plugin_script::ProbeResult / cli_installer::InstallTarget / InstallStatus / InstallResult 的 serde 输出形态。
// - 这些是 **Rust serde 默认命名**（ProbeResult 用原字段名；InstallResult 走 snake_case），
//   与 HTTP DTO（/api/llm/* 的 camelCase）命名不同——故独立于此文件，不与契约包混淆。
//
// 前端调用经 lib/install-cli.ts 封装层转换为 camelCase 后再给 UI 用，避免类型串台。

/** Rust probe_script_runtime 返回（snake_case）。Node/Python 运行时探测。 */
export interface ProbeResult {
  available: boolean;
  binary_path: string | null;
  version: string | null;
  hint: string | null;
}

export type RuntimeInstallTarget = 'nodejs' | 'python';
export type InstallTarget = RuntimeInstallTarget;

/** Rust InstallStatus（serde PascalCase）。安装结果状态。 */
export type InstallStatus = 'Succeeded' | 'NeedsConfirmation' | 'Failed' | 'Unsupported';

/** Rust InstallResult（serde snake_case）。install_runtime 命令返回。 */
export interface InstallResult {
  status: InstallStatus;
  exit_code: number | null;
  elapsed_ms: number;
  binary_path: string | null;
  version: string | null;
  message: string;
}

/** install-runtime://done 事件 payload（Rust emit）。 */
export interface InstallDonePayload {
  target: InstallTarget;
  status: InstallStatus;
}

