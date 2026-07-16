import { useState } from 'react';
import { toast } from 'sonner';
import type { LoadedPlugin, PendingAutoFix, PluginDraft } from '@/lib/types';
import { copyInstallationToDraft, loadDraftWorkspacePlugin } from '@/lib/plugin-registry';
import { errorMessage } from '../plugins-runtime';

type RunnerActionDeps = {
  plugin: LoadedPlugin;
  setCurrentDraft: (draft: PluginDraft | null) => void;
  setPendingAutoFix: (fix: PendingAutoFix | null) => void;
  setPendingDraftEdit: (edit: { draft: LoadedPlugin; turns: unknown[] } | null) => void;
  setRunningPlugin: (plugin: LoadedPlugin | null) => void;
  setView: (view: 'creator') => void;
};

export function usePluginRunnerActions({
  plugin,
  setCurrentDraft,
  setPendingAutoFix,
  setPendingDraftEdit,
  setRunningPlugin,
  setView,
}: RunnerActionDeps) {
  const [editing, setEditing] = useState(false);

  async function handleAutoFix(stderr: string) {
    try {
      const editable = await prepareEditableDraft(plugin);
      setCurrentDraft(draftFromPlugin(editable));
      // 结构化载荷：提示词（含插件信息 + 报错）+ 出错插件本体（创建器引用其源码注入上下文）。
      setPendingAutoFix({ prompt: autoFixPrompt(stderr, plugin), plugin: editable });
      setRunningPlugin(null);
      setView('creator');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function editInGenerator() {
    setEditing(true);
    try {
      const editable = await prepareEditableDraft(plugin);
      setCurrentDraft(draftFromPlugin(editable));
      setPendingDraftEdit({ draft: editable, turns: [] });
      setRunningPlugin(null);
      setView('creator');
    } catch (caught) {
      toast.error(errorMessage(caught));
      setEditing(false);
    }
  }

  return { editing, editInGenerator, handleAutoFix };
}

async function prepareEditableDraft(plugin: LoadedPlugin): Promise<LoadedPlugin> {
  if (plugin.installationId) {
    const workspace = await copyInstallationToDraft(plugin.installationId);
    return loadDraftWorkspacePlugin(workspace);
  }
  if (plugin.draft && plugin.files?.length) return plugin;
  throw new Error('插件必须先复制为草稿工作区才能编辑。');
}

export function draftFromPlugin(plugin: LoadedPlugin): PluginDraft {
  return {
    id: plugin.id,
    status: plugin.status || 'ready',
    files: plugin.files || [],
    turns: [],
    diagnostics: [],
    plugin_id: plugin.id,
  };
}

const RUNTIME_LABEL: Record<NonNullable<LoadedPlugin['runtime_type']>, string> = {
  client: '网页',
  nodejs: 'Node.js',
  python: 'Python',
  cloud: '云端',
  workflow: '工作流',
};

/**
 * 构造一键修复提示词：带上插件信息（名称/运行时）+ 报错原文 + 修复指引。
 * 创建器会另把插件源码作为引用注入上下文，故此处提示词只需指明"基于现有源码修"。
 * 导出供单测覆盖文案构造。
 */
export function autoFixPrompt(stderr: string, plugin: LoadedPlugin): string {
  const runtime = plugin.runtime_type ? RUNTIME_LABEL[plugin.runtime_type] : '未知';
  return [
    `插件「${plugin.name}」(${runtime}) 启动/运行报错，请定位并修复：`,
    '```',
    stderr.trim() || '(无错误输出)',
    '```',
    '请基于当前插件源码（已在上下文中）修复问题，并重新写出完整文件。',
  ].join('\n');
}
