// 共享的二进制占位过滤 helper。草稿生命周期已由 DraftWorkspace ledger 管理。

/**
 * 二进制文件占位标记（Rust read_plugin_file 对非 UTF-8 文件返回此字符串）。
 *
 * 草稿加载会遍历目录全部文件，二进制文件（PNG/ICO 图标等）无法作为 UTF-8 文本返回，
 * Rust 层返回此占位让前端能继续加载其余文本文件，而不是整个加载失败。
 *
 * 写回磁盘时必须跳过占位文件（否则会用占位文本覆盖原二进制内容）。
 */
const BINARY_PLACEHOLDER_PREFIX = '[binary file,';

/** 判断文件内容是否为二进制占位标记（Rust 层对非 UTF-8 文件的兜底返回）。 */
export function isBinaryPlaceholder(content: string): boolean {
  return content.startsWith(BINARY_PLACEHOLDER_PREFIX);
}

/** 过滤掉二进制占位文件（写回磁盘时调用，避免占位文本覆盖原二进制）。 */
export function filterWritableFiles<T extends { content: string }>(files: T[]): T[] {
  return files.filter((f) => !isBinaryPlaceholder(f.content));
}

// 注：旧的 .lfplugin JSON 单文件导入/导出（exportDraftPlugin/parseDraftBundle/importDraftBundle/DraftBundle）
// 已迁移为 Rust 管理的 .lfplugin v4 ZIP 包格式。旧格式无存量文件，不做兼容。
// 导入/导出请使用 exportPluginToZip / parsePluginZip / materializeZipPlugin。
