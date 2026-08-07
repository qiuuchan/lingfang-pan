# 管理端完善（引导向导+设置+View交互+Dashboard+导航+动画）

## Goal（目标）

把 collab-admin 管理后台从「能用」提升到「完整产品级」：首登分步引导向导 + 平台设置页 + 现有 View 交互完善 + Dashboard 增强 + 导航布局优化 + framer-motion 全面动画。

## 范围（6 块，用户全选确认）

### 1. 首登分步引导向导

首次登录 admin 弹分步向导（localStorage 标记，完成不再弹）：

1. 配置平台信息（平台名称/logo 提示）
2. 设模型服务（引导去 llmProviders 创建 provider + 设 active）
3. 创建首个团队
4. 发布首个版本（引导去 release 模块）
   每步「去完成」跳转 + 「跳过/下一步」，全部完成打勾。

### 2. 平台设置页（新增 View）

- navItems 加「平台设置」。
- 平台名称/logo 展示 + 编辑。
- 全局配置：默认后端地址、SMTP 邮件配置展示、备份提示等（只读展示为主，可编辑的接后端）。
- 主题切换（亮/暗）。

### 3. 现有 View 交互完善

- **详情抽屉**：plugins/users/teams 列表点行打开侧边 Sheet 详情（而非只有表格）。
- **筛选搜索**：列表加搜索框 + 状态筛选。
- **批量操作**：表格多选 + 批量启用/禁用/删除。

### 4. Dashboard 增强

- 更多指标卡片（framer-motion 入场动画）：生成质量、财务、用户增长、待办。
- 图表（用 framer-motion 做简易条形图/趋势线，不引重量级图表库）。
- 卡片悬停交互。

### 5. 导航布局优化

- 侧栏分组（核心管理/内容/系统）。
- 面包屑（各 View 顶部显示当前位置）。
- 快捷搜索（Cmd+K 风格，搜 View/操作）——可选，复杂则留 TODO。

### 6. framer-motion 动画

- 已装 framer-motion ^12.40.0。
- 页面切换转场（View 切换 fade+slide）。
- 列表项交错入场（stagger）。
- 卡片悬停弹性。
- 数据加载 shimmer（骨架屏）。
- 数字滚动动画（指标卡片）。

## Constraints

- 简体中文。UTF-8 无 BOM。
- 复用现有 UI 组件（card/dialog/sheet/table/tabs 等）+ framer-motion。
- 鸿蒙字体已配置（HarmonyOS Sans SC），新页面用 --font-sans 变量。
- 不破坏现有 View 功能（增量增强）。
- 后端若需新端点（如平台设置保存），标注 TODO 或用 localStorage 临时存（不阻塞 UI）。

## Acceptance Criteria

- [ ] AC1 首次登录弹引导向导（4 步），完成/跳过后不再弹。
- [ ] AC2 平台设置页可访问，含平台信息 + 配置展示。
- [ ] AC3 现有 View（至少 plugins/users）有详情抽屉 + 筛选搜索。
- [ ] AC4 Dashboard 有动画指标卡片 + 简易图表。
- [ ] AC5 导航侧栏分组 + 面包屑。
- [ ] AC6 页面切换有 framer-motion 转场动画。
- [ ] AC7 列表项有交错入场 + 卡片悬停动画。
- [ ] AC8 typecheck/build 全绿，无回归。
