// cli-types.ts — 桌面 CLI 与运行时探测/安装的类型定义。
//
// 职责：
// - 镜像 Rust 侧 code_assistant::ToolAvailability / plugin_script::ProbeResult /
//   cli_installer::InstallTarget / InstallStatus / InstallResult 的 serde 输出形态。
// - 这些是 **Rust serde 默认命名**（ToolAvailability 用原字段名；InstallResult 走 snake_case），
//   与 HTTP DTO（/api/llm/* 的 camelCase）命名不同——故独立于此文件，不与契约包混淆。
//
// 前端调用经 lib/install-cli.ts 封装层转换为 camelCase 后再给 UI 用，避免类型串台。

/** Rust CodeAssistantTool（kebab-case serde）。CLI 工具枚举。 */
export type CliToolId = 'claude' | 'codex' | 'opencode';

/** Rust list_tools/check_tool 返回（serde 原字段名，camelCase 已是 Rust 端定义）。 */
export interface ToolAvailability {
  tool: CliToolId;
  display_name: string;
  available: boolean;
  binary_path: string | null;
  version: string | null;
  models: string[];
  default_model: string;
  last_check: string;
  probe_status: string; // 现状恒 'not_run'，UI 不据此判定（design B14），只用 available
  diagnostics: string[];
}

/** Rust probe_script_runtime 返回（snake_case）。Node/Python 运行时探测。 */
export interface ProbeResult {
  available: boolean;
  binary_path: string | null;
  version: string | null;
  hint: string | null;
}

/** Rust InstallTarget（serde lowercase）。5 类安装目标（3 CLI + 2 运行时）。 */
export type InstallTarget = CliToolId | 'nodejs' | 'python';

/** 仅 CLI 类（install_cli 命令入参）。 */
export type CliInstallTarget = CliToolId;

/** 仅运行时类（install_runtime 命令入参）。 */
export type RuntimeInstallTarget = 'nodejs' | 'python';

/** Rust InstallStatus（serde PascalCase）。安装结果状态。 */
export type InstallStatus = 'Succeeded' | 'NeedsConfirmation' | 'Failed' | 'Unsupported';

/** Rust InstallResult（serde snake_case）。install_cli/install_runtime 命令返回。 */
export interface InstallResult {
  status: InstallStatus;
  exit_code: number | null;
  elapsed_ms: number;
  binary_path: string | null;
  version: string | null;
  message: string;
}

/** install-cli://done 事件 payload（Rust emit）。 */
export interface InstallDonePayload {
  target: InstallTarget;
  status: InstallStatus;
}

/** code-assistant://availability-changed 事件 payload（与 main.rs:232 首启 emit 同形态）。 */
export type AvailabilityChangedPayload = ToolAvailability[];
