// use-local-import.ts —— 本地插件导入/导出 hook（ZIP 包 `.lfplugin`）。
//
// 与 FloatingCreator 已有的「导入文件夹→草稿」不同：
// - 这里导入 `.lfplugin` ZIP 包，按包内 _meta.json.source 落点（local→本地可运行，draft→草稿）。
// - 本地 tab 的导入默认接受 local 源包；draft 源包也接受但提示去草稿 tab。
//
// 复用：
// - parsePluginZip / materializeZipPlugin（lib/plugin-package-zip.ts）：解析 ZIP + 物化。
// - dedupeImportId（本文件导出，zip 模块也复用）：plugin_id 冲突时追加 -2/-3 防覆盖。
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { parsePluginZip, materializeZipPlugin, type ZipImportResult } from '@/lib/plugin-package-zip';
import { errorMessage } from '../plugins-runtime';

/**
 * 为导入插件生成不与现有 id 冲突的最终 plugin_id。
 * 冲突时追加 -2/-3/...（safePluginId 保证合法 [A-Za-z0-9_-]）。
 */
export function dedupeImportId(baseId: string, existingIds: string[]): string {
  const ids = new Set(existingIds);
  if (!ids.has(baseId)) return baseId;
  let n = 2;
  while (ids.has(`${baseId}-${n}`)) n += 1;
  return `${baseId}-${n}`;
}

/**
 * 导入预览：parsePluginZip 的结果，供确认对话框展示。
 * 用户可改名（影响最终 plugin_id 与 manifest.name/title），确认后才真正落盘。
 */
export type LocalImportPreview = ZipImportResult & { userRenamedName: string };

export function useLocalImport(
  existingIds: string[],
  onDone: () => void,
  /** 现有插件的 id→version 映射，用于版本感知覆盖（包版本更高 → 覆盖升级不改名）。 */
  existingVersions?: Record<string, string>,
) {
  // 隐藏 <input type=file accept=".lfplugin">：用户点「导入」→ click() → change 读 File。
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  // 预览态：解析 ZIP 成功后弹确认对话框（可改名），确认后才物化落盘。
  const [preview, setPreview] = useState<LocalImportPreview | null>(null);
  // 确认对话框里可编辑的插件名（初始 = 预览的 name）。
  const [editingName, setEditingName] = useState('');

  /** 触发系统文件选择对话框（accept .lfplugin）。 */
  const pickFile = useCallback(() => {
    inputRef.current?.click();
  }, []);

  /** <input> change 回调：读 .lfplugin → parsePluginZip → 进预览态。 */
  const onFilePicked = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const result = await parsePluginZip(file);
      setPreview({ ...result, userRenamedName: result.name });
      setEditingName(result.name);
    } catch (err) {
      toast.error(`导入失败：${errorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  }, []);

  /** 确认导入：按用户命名重算 id（去重/升级）→ materializeZipPlugin 物化（据 source 落 draft/local）。 */
  const confirmImport = useCallback(async () => {
    if (!preview) return;
    const trimmed = editingName.trim();
    if (!trimmed) {
      toast.error('插件名称不能为空');
      return;
    }
    setImporting(true);
    try {
      // 用户改名写入 manifest.title（保留原 name 字段），使导入后列表展示用新名。
      const manifestWithTitle = { ...preview.manifest, title: trimmed };
      const staged: ZipImportResult = { ...preview, manifest: manifestWithTitle };
      const { id, source, upgraded } = await materializeZipPlugin(staged, existingIds, existingVersions);
      void id; // id 仅用于日志/调试，不在此展示
      const incomingVersion = String(staged.manifest.version ?? '');
      if (upgraded) {
        toast.success(`已升级「${trimmed}」到 v${incomingVersion}（覆盖了本地的旧版本）`);
      } else if (source === 'draft') {
        toast.success(`已导入「${trimmed}」到草稿（包标记为草稿来源），可在「我的草稿」查看`);
      } else {
        toast.success(`已导入「${trimmed}」，可直接运行`);
      }
      setPreview(null);
      setEditingName('');
      onDone();
    } catch (err) {
      toast.error(`导入失败：${errorMessage(err)}`);
    } finally {
      setImporting(false);
    }
  }, [preview, editingName, existingIds, onDone]);

  /** 取消预览对话框。 */
  const cancelImport = useCallback(() => {
    setPreview(null);
    setEditingName('');
  }, []);

  return {
    inputRef,
    importing,
    preview,
    editingName,
    setEditingName,
    pickFile,
    onFilePicked,
    confirmImport,
    cancelImport,
  };
}
