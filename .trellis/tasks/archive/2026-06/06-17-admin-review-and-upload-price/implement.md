# 执行计划：补全 admin 审核按钮 + 上传期设价

## 步骤 1：admin 审核按钮

- `apps/collab-admin/src/components/plugins-view.tsx`：
  - 详情抽屉加审核区：`plugin.reviewStatus === 'PENDING'` 时显示「通过审核」「驳回」按钮。
  - 通过：`run(() => api('/api/admin/plugins/:id/approve', { method: 'POST' }).then(onRefresh), '已通过')`。
  - 驳回：Dialog（reason Textarea）→ `api('/api/admin/plugins/:id/reject', { method: 'POST', body: { reason } })` → onRefresh。
  - 复用 useGuardedAction + Dialog（与 PluginDelistDialog 同模式）。

## 步骤 2：上传期设价

- `apps/desktop/src/pages/PluginCreatorHome.tsx`：
  - 命名 Dialog 加「定价（元）」Input + priceYuan state。
  - doUpload：`priceCents = priceYuan.trim() ? yuanToCents(priceYuan) : 0`，body 加 priceCents。
  - import yuanToCents（money.ts）。
  - 上传后清空 priceYuan。

## 验证命令

- 前端：`pnpm -C apps/collab-admin typecheck` + `pnpm -C apps/desktop typecheck`
- 手动：admin PENDING 插件通过/驳回；创建器上传填价 → 插件 priceCents 为该值。

## 实现顺序

1. 步骤 1（admin 审核按钮）→ admin typecheck
2. 步骤 2（上传设价）→ 桌面 typecheck
3. 手动验证

## 风险与回滚点

- 审核按钮仅 PENDING 显示 → 非 PENDING 不影响。回滚 = 删按钮。
- 价格输入 yuanToCents 校验 → 非法 toast 拦截。回滚 = 删价格输入。
