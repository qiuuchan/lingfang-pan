import { useState } from 'react';
import { toast } from 'sonner';
import type { LoadedPlugin, PluginDraft } from '@/lib/types';
import { writePluginFiles } from '@/lib/plugin-status';
import { errorMessage } from '../plugins-runtime';

type RunnerActionDeps = {
  plugin: LoadedPlugin;
  setCurrentDraft: (draft: PluginDraft | null) => void;
  setPendingAutoFixPrompt: (prompt: string | null) => void;
  setRunningPlugin: (plugin: LoadedPlugin | null) => void;
  setView: (view: 'creator') => void;
};

export function usePluginRunnerActions({
  plugin,
  setCurrentDraft,
  setPendingAutoFixPrompt,
  setRunningPlugin,
  setView,
}: RunnerActionDeps) {
  const [editing, setEditing] = useState(false);

  async function handleAutoFix(stderr: string) {
    try {
      await persistPluginFiles(plugin);
      setCurrentDraft(draftFromPlugin(plugin));
      setPendingAutoFixPrompt(autoFixPrompt(stderr));
      setRunningPlugin(null);
      setView('creator');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function editInGenerator() {
    setEditing(true);
    try {
      if (!plugin.files?.length) throw new Error('插件缺少安装文件，无法进入编辑器。');
      await persistPluginFiles(plugin);
      setCurrentDraft(draftFromPlugin(plugin));
      setRunningPlugin(null);
      setView('creator');
    } catch (caught) {
      toast.error(errorMessage(caught));
      setEditing(false);
    }
  }

  return { editing, editInGenerator, handleAutoFix };
}

async function persistPluginFiles(plugin: LoadedPlugin): Promise<void> {
  if (plugin.files?.length) await writePluginFiles(plugin.id, plugin.files);
}

function draftFromPlugin(plugin: LoadedPlugin): PluginDraft {
  return {
    id: plugin.id,
    status: plugin.status || 'ready',
    files: plugin.files || [],
    turns: [],
    diagnostics: [],
    plugin_id: plugin.id,
  };
}

function autoFixPrompt(stderr: string): string {
  return `插件运行时报错，请定位并修复：\n\`\`\`\n${stderr}\n\`\`\`\n请修复问题并重新写出完整文件。`;
}
