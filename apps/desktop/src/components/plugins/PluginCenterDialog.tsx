// PluginCenterDialog.tsx — 插件中心居中悬浮窗容器（路线 A）。
//
// 与 PanelDialog 区别：PanelDialog 自带单一 ScrollArea 包裹 children，不适配「左侧栏 + 右侧内容各自滚动」
// 的两栏布局。本容器用裸 Dialog + DialogContent（大尺寸），body 自行分栏滚动（见 PluginCenterBody）。
// 不复用 PanelDialog 以避免动公共组件波及其余五个悬浮窗。
import { PuzzleIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { dragRegionProps } from '@/lib/window-drag';
import type { LoadedPlugin } from '@/lib/types';
import { PluginCenterBody } from '@/pages/plugins/PluginCenterBody';
import type { PluginCenterTab } from '@/pages/plugins/use-plugin-center';

export function PluginCenterDialog({
  open,
  onOpenChange,
  tab,
  onTabChange,
  onRun,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: PluginCenterTab;
  onTabChange: (tab: PluginCenterTab) => void;
  /** 运行某插件：App 设 runningPlugin（全屏 overlay 接管）并关闭本悬浮窗。 */
  onRun: (plugin: LoadedPlugin) => void;
  /** 打开创建器（团队空态「创建插件」入口）。 */
  onCreate: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] max-h-[86vh] w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="border-b px-5 py-4" {...dragRegionProps}>
          <DialogTitle className="flex items-center gap-2" data-tauri-drag-region>
            <PuzzleIcon className="size-4" />插件管理
          </DialogTitle>
          <DialogDescription>本地运行、团队共享、市场发现都在这里；左侧可固定常用与查看历史。</DialogDescription>
        </DialogHeader>
        <PluginCenterBody tab={tab} onTabChange={onTabChange} onRun={onRun} onCreate={onCreate} />
      </DialogContent>
    </Dialog>
  );
}
