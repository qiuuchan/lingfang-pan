# Design: Dashboard And Settings Lazy Loading

## Dashboard

Files:

- `components/dashboard.tsx`: 资源协调和导航 intent。
- `components/dashboard/core-metrics.tsx`: 核心指标。
- `components/dashboard/governance-todos.tsx`: 两类治理待办。
- `components/dashboard/on-demand-insights.tsx`: 生成质量/财务分析 Tabs。

Initial mount only calls `/api/admin/dashboard`. Insights use `useAsyncResource(enabled=activeInsight===...)` and cache the successful result for the view session.

Dashboard navigation intent includes governance Tab and initial filter. App/view state may use a small typed payload rather than adding a router.

## Footer And About

- Footer 变为无网络的静态构建信息或从主工作区移除。
- changelog 只在 ChangelogPage 打开时加载。
- About 保留版本、更新检查和项目链接；Settings 不再重复技术栈说明。

## Settings

```text
settings-view.tsx                   tabs + visitedTabs
settings/platform-settings-tab.tsx platform info + theme + version
settings/smtp-settings-tab.tsx
settings/security-settings-tab.tsx geetest
settings/release-source-settings-tab.tsx gitee
settings/search-settings-tab.tsx
settings/settings-api.ts            DTO mapping + requests
```

`visitedTabs` 在 Tab 首次激活后挂载组件，之后保持挂载以保存 draft。每个 Tab 自己拥有 load/save/test 状态；只有共享 toast 和平台信息更新回调提升到 shell。

现有宽版 `GET /api/admin/settings` 不再返回原始 `PlatformSetting.value`。优先删除未使用 route；若兼容期必须保留，则对统一 `SECRET_KEYS` 白名单强制返回 masked/hasValue 投影，明文只允许走 `reveal-secret` 二次密码确认接口。

基础 Tab 可复用 App 已加载的 platform info 快照，必要时显式刷新；避免同一时刻重复请求公开 endpoint。

## Visual

- Dashboard 只保留紧凑 KPI、治理待办和可展开 insights。
- Settings 使用顶部可横滚 Tabs，单一内容区域，不再纵向堆叠七张卡。
- 配置表单内部用 section divider，避免 card nesting。
