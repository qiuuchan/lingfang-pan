# 插件市场治理来源与状态整合

## Goal

让平台管理员按插件包高效治理 v4 registry：看见真实来源和四轴状态，准确识别市场当前版，安全执行审核/暂停/恢复，并让 Dashboard 插件指标脱离旧 Plugin 双模型。

## Requirements

- 管理列表以 package 为单位服务端分页、搜索、状态筛选，不一次返回 500 个完整 manifest。
- package row 展示 owner team、package status、latest release/version/source、pending count、listing status/current version。
- 打开 package 后按需加载 release summaries；选择 release 后加载核心详情，manifest/files/reviews 分区按需。
- release 详情展示 sourceKind/sourceLabel/ingestChannel，并明确其为发布来源记录。
- `isMarketplaceCurrent` 仅当 listing ACTIVE 且 currentReleaseId 等于该 release。
- approve/reject 只对 PENDING 显示；platform suspend 只对当前 ACTIVE listing 显示；platform relist 只对 PLATFORM 下架显示。
- 危险动作需要原因和确认，提交期间防重复。
- 操作后局部刷新当前 package/release、pending count 和 Dashboard 待办。
- Dashboard pending plugin review、active/delisted package/listing 等指标改用 PluginRelease/MarketplaceListing。
- 保留现有 admin UI foundation 未提交改动并复用 AsyncResource、DetailSheet、Pagination。
- 与 `07-12-admin-governance-center` 兼容：本任务只实现插件域；团队管理员申请 Tab 和最终导航合并仍由原任务完成。

## Acceptance Criteria

- [x] 首屏只加载一页 package 摘要，响应不含 manifest/fileManifest/reviews。
- [x] 未打开 package/release/详情分区时对应详情请求为 0。
- [x] 管理员能看到每个 release 的发布来源、接入通道和四轴状态。
- [x] 只有精确 current release 显示“市场当前版”和平台下架动作。
- [x] approve/reject 并发冲突显示 409，不产生矛盾 UI 状态。
- [x] 平台暂停记录原因/操作者，作者不能恢复；平台恢复后 current release 不变量成立。
- [x] 操作完成后列表、详情、待审核数和 Dashboard 指标一致。
- [x] 旧 Plugin.reviewStatus 不再驱动 v4 插件待审核指标。
- [x] collab-admin typecheck/build 与相关 backend tests 通过，桌面/窄屏无溢出遮挡。

## Out Of Scope

- 团队管理员申请的事务修复和 UI。
- 合并所有审批到一个通用数据库状态机。
- 删除旧 Plugin 表或完成全部 legacy cutover。

## Planning Status

- 依赖 registry 后端子任务完成；复用现有 admin governance 设计，不存在阻塞决策。
