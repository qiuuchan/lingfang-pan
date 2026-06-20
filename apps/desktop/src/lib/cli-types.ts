// cli-types.ts — 桌面脚本运行时探测类型定义。
//
// 职责：
// - 镜像 Rust 侧 plugin_script::ProbeResult 的 serde 输出形态。
// - 这些是 **Rust serde 默认命名**（ProbeResult 用原字段名），
//   与 HTTP DTO（/api/llm/* 的 camelCase）命名不同——故独立于此文件，不与契约包混淆。
//
// 插件脚本运行时只允许使用应用包内置 runtimes/ 下的 Node.js / Python，不再定义系统安装类型。

/** Rust probe_script_runtime 返回（snake_case）。Node/Python 运行时探测。 */
export interface ProbeResult {
  available: boolean;
  binary_path: string | null;
  version: string | null;
  hint: string | null;
}

export type RuntimeTarget = 'nodejs' | 'python';

