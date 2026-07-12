# 统一治理中心与插件审批按需加载

## Goal

将插件管理和审批管理合并为一个治理中心，以插件包和团队管理员申请为业务 Tab，所有详情按打开对象和子 Tab 动态加载，并修复审核状态一致性问题。

## Requirements

- 侧栏新增单一“治理中心”，移除独立“插件管理”和“审批管理”。
- “插件发行”以插件包为一行，服务端分页、搜索和状态筛选；列表不含 manifest、文件清单或审核历史。
- 打开插件包后才加载 package overview 和 release summaries；选择发行版后加载核心详情；manifest/files/reviews 分 Tab 首次加载。
- “团队管理员申请”服务端分页；点击申请后才加载完整理由和处理信息。
- 通过、驳回、下架在同一 DetailSheet 上下文完成；危险动作保留确认 Dialog。
- 审核/审批状态转换使用事务内条件更新，并发请求只能一个成功。
- 同包多个已通过版本以最高严格 SemVer 作为市场当前版，旧版晚通过不得降级市场。
- 下架使用 package 级语义；历史版、制品和权益保留。
- 仪表盘待审核插件计数迁移到 `PluginRelease.marketReviewStatus=PENDING`，入口由后续 Dashboard 子任务接入。

## Acceptance Criteria

- [x] 治理中心首开只请求当前 Tab 第一页。
- [x] 插件列表每包一行，响应无 manifest/fileManifest/reviews。
- [x] 未打开插件、发行版或详情子 Tab 时对应请求数为 0。
- [x] 只有 ACTIVE listing 的 `currentReleaseId` 显示“市场当前版”。
- [x] 并发 approve/reject 只有一个成功，失败者 409，且只有一条终态 review/audit。
- [x] 同包不同版本并发通过后当前版稳定为最高 SemVer。
- [x] 已处理申请无动作；并发通过/驳回只有一个成功，不能同时建团和驳回。
- [x] 快速切换包、发行版或申请时旧响应不覆盖当前对象。
- [x] Contract、backend tests/typecheck/build、admin typecheck/build 通过。

## Out Of Scope

- 市场显式回滚到旧版本。
- 修改插件制品格式、桌面安装状态和 entitlement 语义。
- 将两种审批合并为同一数据库状态机。
