# 技术设计：补全 admin 审核按钮 + 上传期设价

## 架构与边界

纯前端小补，后端零改动。改动：
- `apps/collab-admin/src/components/plugins-view.tsx` — 详情加审核通过/驳回按钮 + 驳回 reason Dialog。
- `apps/desktop/src/pages/PluginCreatorHome.tsx` — 命名 Dialog 加价格输入 + doUpload 传 priceCents。

## admin 审核按钮

plugins-view 详情抽屉（PluginDelistDialog 附近）加：
- 仅 `plugin.reviewStatus === 'PENDING'` 时显示「通过审核」「驳回」按钮。
- 通过：`POST /api/admin/plugins/:id/approve`（无 body）→ run + onRefresh。
- 驳回：弹 Dialog 输入 reason（Textarea，必填提示）→ `POST /api/admin/plugins/:id/reject` body `{ reason }` → run + onRefresh。
- 复用 `useGuardedAction` / `run` / `Dialog`（与 delist 同模式）。

## 上传期设价

PluginCreatorHome 命名 Dialog（namingOpen）加「定价（元）」Input：
- namingValue 旁加 priceYuan state，留空=免费（0）。
- doUpload：`const priceCents = priceYuan.trim() ? yuanToCents(priceYuan) : 0;`，body 加 `priceCents`。
- 校验：yuanToCents 非法（抛错）→ run toast 拦截。
- 上传后清空 priceYuan。

复用：`yuanToCents`（money.ts，PluginList 已用）。

## 兼容性与回滚

- 全部新增 UI/字段，不影响现有。回滚 = 删按钮/价格输入。
- 后端零改动（approve/reject/upload priceCents 都已支持）。
