# 补全 admin 审核按钮 + 上传期设价

## Goal

补全两个小缺口：

- **admin 审核按钮**：admin plugins-view 详情缺「通过/驳回」按钮（后端 `POST /api/admin/plugins/:id/approve|reject` 端点已有，前端未接）。
- **上传期设价**：创建器上传插件时命名 Dialog 缺价格输入（后端 `PluginPackageDto` 已接受 `priceCents`，前端 doUpload 没传，默认 0 免费上传）。

## 已确认事实（来自代码查证）

- **后端 approve/reject 端点已有**（admin.controller:186/192）：`POST /api/admin/plugins/:id/approve`（无 body）、`POST /api/admin/plugins/:id/reject`（body `AdminRejectPluginDto { reason? }`）。
- **admin plugins-view 缺审核按钮**：有审核筛选/编辑/下架/审核历史，但无 approve/reject 操作按钮（grep 确认）。
- **后端 upload DTO 已接受 priceCents**（plugins.dto.ts:55 `@IsInt @Min(0) priceCents?`），前端 doUpload（PluginCreatorHome:1098）body 只传 `{ manifest, files }`，没传 priceCents（默认 0）。
- **命名 Dialog 已有**（uploadCloud → namingOpen）：用户填名后 doUpload，无价格字段。
- **set-price 端点已有**（上传后改价用），但上传时直接带价更顺（避免上传后再改）。

## Requirements

- R1 admin plugins-view 详情加「通过审核」「驳回」按钮：仅 PENDING 状态显示。通过调 approve（无 body），驳回弹 reason 输入 → reject。操作后刷新。
- R2 驳回 reason 必填提示（后端 reason 可选，但前端引导填，便于通知作者）。
- R3 创建器命名 Dialog 加「定价（元）」输入（可选，留空=免费）。doUpload 把 priceCents（yuanToCents 转分）传给 `/api/plugins/upload`。
- R4 价格输入校验：非负数字，留空=0（免费），非法 toast 拦截。
- R5 不破坏现有上传/命名/审核流程。

## Acceptance Criteria

- [ ] admin plugins-view PENDING 插件详情有「通过审核」按钮 → 点后 reviewStatus=APPROVED + 刷新。
- [ ] admin plugins-view PENDING 插件详情有「驳回」按钮 → 弹 reason 输入 → 提交后 reviewStatus=REJECTED + 通知作者。
- [ ] 非 PENDING 状态不显示审核按钮。
- [ ] 创建器上传命名 Dialog 有「定价」输入 → 填价后上传的插件 priceCents 为该值。
- [ ] 留空定价上传 = 免费（priceCents=0）。
- [ ] typecheck 通过；不破坏现有。

## Out of Scope

- admin 批量审核（一次多个）。
- 上传后改价（已有 set-price，不重复）。
- 审核流程逻辑改动（后端 approve/reject 已完整）。

## Notes

- 轻量任务（纯前端小补，后端零改动），PRD-only 可够，但补 design/implement 明确改动点。
- 改 admin plugins-view（审核按钮）+ PluginCreatorHome 命名 Dialog（价格输入 + doUpload 传价）。
