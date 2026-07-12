// task-steps.ts — 新手任务清单的 5 步定义（与 UI / 持久化解耦，便于单测引用步骤数）。
//
// 每步：图标 + 标题 + 说明 + 跳转目标 View +（Settings 页落地 Tab）。
// 步骤顺序即推荐完成顺序，调整顺序会改变 localStorage 进度数组语义（按下标存），故顺序稳定。

import { CpuIcon, SparklesIcon, MessageSquareIcon, EyeIcon, UploadCloudIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SettingsTab, View } from '@/lib/types';

export interface TaskStep {
  icon: LucideIcon;
  title: string;
  description: string;
  /** 跳转到的页面。 */
  view: View;
  /** Settings 页跳转时落到哪个 Tab（cli/gateway/backend）；非 Settings 页为 undefined。 */
  settingsTab?: SettingsTab;
}

export const TASK_STEPS: TaskStep[] = [
  {
    icon: CpuIcon,
    title: '准备脚本运行环境',
    description: '下载应用管理的便携版 Python / Node.js，或显式采用电脑上已有的版本。',
    view: 'settings',
    settingsTab: 'cli',
  },
  {
    icon: SparklesIcon,
    title: '确认模型服务',
    description: '前往「设置 → 模型与计费」查看平台模型版本；密钥由管理员统一维护。',
    view: 'settings',
    settingsTab: 'gateway',
  },
  {
    icon: MessageSquareIcon,
    title: '发起首条对话',
    description: '回到「创建插件」页，描述你想做的插件，发送第一条消息让 AI 开始生成。',
    view: 'creator',
  },
  {
    icon: EyeIcon,
    title: '使用插件',
    description: '生成完成后点「使用插件」查看插件实际运行效果。',
    view: 'creator',
  },
  {
    icon: UploadCloudIcon,
    title: '上传团队共享',
    description: '在详情面板把生成好的插件上传到团队共享，或提交到插件市场。',
    view: 'creator',
  },
];
