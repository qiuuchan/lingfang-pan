import {
  ActivityIcon,
  BoxesIcon,
  CheckCircleIcon,
  CloudCogIcon,
  CoinsIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  PlugIcon,
  ReceiptIcon,
  RocketIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  UsersIcon,
  ZapIcon,
} from 'lucide-react';
import type { View } from '@/lib/types';

// 导航项类型：view 跳转目标、显示文案、lucide 图标。
export type NavItem = {
  view: View;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

// 导航分组：标题（muted 小字）+ 组内项目。
// 三大分组覆盖现有 8 个视图 + 组A 待加的 settings 视图，保持单一数据源。
export type NavGroup = {
  title: string;
  items: NavItem[];
};

// 全局分组配置——侧栏、面包屑、命令面板统一引用此处，避免多处散落导致文案漂移。
export const NAV_GROUPS: NavGroup[] = [
  {
    title: '核心管理',
    items: [
      { view: 'dashboard', label: '仪表盘', icon: LayoutDashboardIcon },
      { view: 'users', label: '用户管理', icon: UsersIcon },
      { view: 'teams', label: '团队管理', icon: BoxesIcon },
    ],
  },
  {
    title: '内容',
    items: [
      { view: 'plugins', label: '插件管理', icon: PlugIcon },
      { view: 'applications', label: '审批管理', icon: CheckCircleIcon },
    ],
  },
  {
    title: '计费与模型',
    items: [
      { view: 'pools', label: '资源池', icon: ServerIcon },
      { view: 'channels', label: '渠道管理', icon: BoxesIcon },
      { view: 'billing', label: '计费配置', icon: CoinsIcon },
      { view: 'credits', label: '灵石账户', icon: ReceiptIcon },
      { view: 'callLogs', label: '调用日志', icon: ActivityIcon },
      { view: 'apiKeys', label: 'API Key 总览', icon: KeyRoundIcon },
    ],
  },
  {
    title: '系统',
    items: [
      { view: 'roles', label: '角色管理', icon: ShieldIcon },
      { view: 'platformAdmins', label: '平台管理员', icon: ShieldCheckIcon },
      { view: 'audit', label: '审计日志', icon: ActivityIcon },
      { view: 'releases', label: '版本发布', icon: RocketIcon },
      { view: 'settings', label: '平台设置', icon: SettingsIcon },
    ],
  },
];

// 扁平化所有导航项，便于按 view 查找。
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

// VIEW -> 中文文案映射，由 NAV_ITEMS 派生，避免硬编码两份。
export const VIEW_LABEL: Record<View, string> = Object.fromEntries(
  NAV_ITEMS.map(({ view, label }) => [view, label]),
) as Record<View, string>;

// VIEW -> 所属分组标题，供面包屑渲染「分组 / 视图」层级。
export const VIEW_GROUP: Record<View, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.view, group.title])),
) as Record<View, string>;
