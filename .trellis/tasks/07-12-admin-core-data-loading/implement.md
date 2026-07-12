# Implementation Plan

- [x] 新增/复用 admin pagination DTO/helper。
- [x] Users/Admins: backend pagination、role filter、options 和 detail timelines。
- [x] Users/Admins: frontend server pagination、按需详情和 activity。
- [x] Teams: lean list、options、overview 和分 Tab 关联 endpoints。
- [x] Teams: frontend 移除首屏 users 请求和五路详情并发预取。
- [x] Audit: list/detail 分离并保留 filter AND 回归测试。
- [x] Releases: summary/detail 分离和分页。
- [x] Roles: list/detail 分离；编辑器按需加载权限参考数据。
- [x] Tickets: detail 请求取消和乱序保护。
- [x] Tickets: 直接消费 mutation detail 响应；移除 Users/Admins/Teams 重复且文案错误的永久删除入口。
- [x] 每迁移一个 view 运行 targeted backend tests、admin typecheck 和网络断言。
- [x] 全量 collab-api test/typecheck/build、admin typecheck/build、diff check。

## Rollback

按 view 独立迁移；旧 endpoint 保留到对应前端切换完成。任何一个 view 可单独回退而不影响共享分页基础。
