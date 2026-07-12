# 仪表盘与设置按需加载和视觉收敛

## Goal

让 Dashboard 首屏只加载核心治理数据，并将 Settings 拆成按 Tab 首次加载的配置域，减少启动请求和重复信息。

## Requirements

- Dashboard 首屏只请求 `/api/admin/dashboard`。
- 核心指标使用紧凑布局；待办包含待审核插件发行和团队管理员申请，并可进入治理中心正确 Tab/PENDING 筛选。
- 生成质量和财务分析只有用户打开对应区块时才请求，关闭/切换时处理过期响应。
- 不保留重复“快速操作”卡片和与侧栏重复的入口。
- Footer 不再请求 changelog；版本信息集中到 About 或基础设置。
- Settings 拆为基础、邮件、安全、发布源、搜索五个 Tab。
- 默认只挂载基础 Tab；其他 Tab 首次访问才加载，访问后保留未保存草稿。
- 每个设置 Tab 独立 loading/error/ready，失败时不展示可误保存的空表单。
- 删除或收紧宽版 `GET /api/admin/settings`：所有 secret 必须强制脱敏，不能绕过 reveal-secret 的二次密码确认。
- Settings 文件按真实职责拆分，主 view 仅负责编排。

## Acceptance Criteria

- [x] Dashboard 初始网络请求不含 generation、finance 或 changelog。
- [x] 点击分析区后才请求对应接口，切回不无意义重复请求。
- [x] 待办数字来自新 release 级审核模型，入口定位正确。
- [x] Settings 初始只请求基础域；SMTP/Geetest/Gitee/Search 未打开时请求数为 0。
- [x] Settings 切回已访问 Tab 保留草稿且不重复加载。
- [x] 配置加载失败不显示空可保存表单。
- [x] 任意设置列表/域接口均不返回 SMTP、Geetest、Gitee、Tavily、Brave 等密钥明文。
- [x] `settings-view.tsx` 拆分符合 1000+ 行文件规范。
- [x] admin typecheck/build 和多视口检查通过。

## Out Of Scope

- 修改统计口径、配置 key 或后端配置保存语义。
- 新增报表系统。
