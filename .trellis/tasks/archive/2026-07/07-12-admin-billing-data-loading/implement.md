# Implementation Plan

> 完成记录（2026-07-12）：计费集合统一服务端分页；Channels 当前 Tab 与编辑详情按需加载；Credits 单查询返回余额摘要且 GET 不创建账户；Call Log 列表/详情分离；API Key 使用白名单投影。

- [x] Pools list/options pagination and tests。
- [x] Channels current-kind pagination、detail、pricing and tests。
- [x] Pricing pagination/filter and uniqueness regressions。
- [x] Credits paged team balance query，移除前端 N+1。
- [x] 审计 Credits read path，确保 GET 无 create/update/reward side effect。
- [x] Credits ledger pagination and on-demand Sheet。
- [x] Call logs summary/detail separation and filters。
- [x] API Key pagination and sensitive-field regressions。
- [x] 模型价格并入模型接入按需 Tab；API Key query 改白名单 select，不读取 keyHash。
- [x] Frontend 全部迁移到 shared AsyncResource/Pagination，未打开区域零请求。
- [x] 运行 billing targeted tests、full backend quality gate、admin build 和网络断言。

## Rollback

逐 endpoint/view 迁移并保留旧宽响应一版。Credits 新只读查询独立于写入 helper，可单独回退。
