import { motion, AnimatePresence } from 'framer-motion';
import { Loader2Icon, PlayIcon, Code2Icon } from 'lucide-react';
import type { PluginWorkspaceMode } from '@/lib/types';

// 工作区切换全屏过渡动画：运行 ↔ 开发插件切换时短暂覆盖主区，
// 显示「正在切换工作区」+ 旋转 loader，淡入淡出后自动消失。
export function WorkspaceTransition({
  active,
  mode,
}: {
  active: boolean;
  mode: PluginWorkspaceMode;
}) {
  const Icon = mode === 'develop' ? Code2Icon : PlayIcon;
  const label = mode === 'develop' ? '开发插件' : '运行插件';
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <motion.div
            className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <Icon className="size-8" />
          </motion.div>
          <motion.div
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, delay: 0.05 }}
          >
            <Loader2Icon className="size-4 animate-spin" />
            正在切换到「{label}」工作区…
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
