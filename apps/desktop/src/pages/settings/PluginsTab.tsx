// PluginsTab.tsx — 设置页 Tab：插件存放路径配置（task 06-16-plugin-system-rebuild 组A）。
//
// 职责（PRD 需求 6 / AC7）：
// - 展示当前插件根目录路径（get_plugins_root 读取，默认 app_data/plugins/）。
// - 用户输入新路径 → 测试可创建（Rust set_plugins_root 内 mkdir -p + 校验是目录）→ 保存。
// - 改路径后已有插件迁移策略：Constraints 末条约定——原路径保留，提示用户手动迁移
//   （UI 显式文案说明，不自动搬迁避免大目录 IO 风险）。
//
// 数据来源（Rust 命令，lib/plugin-status.ts 封装）：
// - getPluginsRoot()：读取当前生效路径。
// - setPluginsRoot(path)：规范化（去尾斜杠）+ 创建 + 持久化，返回最终生效路径。
//
// 与组B/C 的关系：路径配置仅组A 负责（单一真源 PluginStore.config.json）。
// 组B 的 start_plugin 经 PluginStore.ensure_plugin_dir 用同一 plugins_root 解析插件目录，
// 组C 的 Plugins.tsx 经 scan_plugin_status 扫同一目录。改路径后三方立即生效（无缓存）。

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FolderIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';
import { getPluginsRoot, openPluginsRoot, setPluginsRoot } from '@/lib/plugin-status';

/** 友好提取错误消息：Tauri 命令 reject 以 Error 形式抛出（message 为 Rust 返回的字符串错误）。 */
function errorMessage(error: unknown): string {
  if (error == null) return '未知错误';
  if (error instanceof Error) return error.message;
  const msg = (error as { message?: unknown }).message;
  return typeof msg === 'string' && msg.length > 0 ? msg : String(error);
}

/**
 * 插件存放路径配置 Tab。
 *
 * 自管 state（currentRoot + input + saving），挂载时拉取当前路径。
 * 保存：调 setPluginsRoot，成功后用返回的规范化路径更新展示 + toast。
 * 失败（路径不可创建/非目录）走 catch toast（ApiError.message）。
 */
export function PluginsTab() {
  // 当前生效路径（挂载时拉取，保存成功后更新）。null=加载中，''=读取失败兜底空。
  const [currentRoot, setCurrentRoot] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  // 挂载时拉取当前 plugins_root。失败兜底空串（不阻断页面，用户可重新输入）。
  useEffect(() => {
    void getPluginsRoot()
      .then((path) => {
        setCurrentRoot(path);
        setInput(path);
      })
      .catch(() => {
        setCurrentRoot('');
      });
  }, []);

  /** 保存插件存放路径：调 set_plugins_root，Rust 侧校验 + 创建目录 + 持久化。 */
  async function savePath() {
    setSaving(true);
    try {
      const effective = await setPluginsRoot(input);
      setCurrentRoot(effective);
      setInput(effective);
      toast.success('插件存放路径已保存');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** 恢复默认路径：传空串触发 Rust 侧 plugins_root_path=None（回退 app_data/plugins/）。 */
  async function resetDefault() {
    setSaving(true);
    try {
      const effective = await setPluginsRoot('');
      setCurrentRoot(effective);
      setInput(effective);
      toast.success('已恢复默认插件存放路径');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function openRoot() {
    try {
      await openPluginsRoot();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <FolderIcon className="size-5 text-primary" />
          <CardTitle>插件存放路径</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="text-sm text-muted-foreground">
          当前路径：
          <span className="font-mono text-foreground">
            {currentRoot === null ? '读取中…' : currentRoot || '未配置'}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="pluginsRootPath">插件根目录</Label>
          <Input
            id="pluginsRootPath"
            placeholder="例如 D:\\MyPlugins 或留空使用默认路径"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && savePath()}
          />
        </div>
        <div className="flex items-center gap-2">
          <LoadingButton loading={saving} onClick={() => { void savePath(); }}>保存路径</LoadingButton>
          <LoadingButton variant="outline" loading={saving} onClick={() => { void resetDefault(); }}>
            恢复默认
          </LoadingButton>
          <LoadingButton variant="outline" loading={false} onClick={() => { void openRoot(); }}>
            打开目录
          </LoadingButton>
        </div>
        <p className="text-xs text-muted-foreground">
          创建器生成的插件会保存在此目录下，重启软件后仍可用。修改路径后，原目录中的插件不会自动迁移，
          如需保留请在修改前手动把旧目录内容复制到新路径。
        </p>
      </CardContent>
    </Card>
  );
}
