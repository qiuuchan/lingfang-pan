# 核心管理列表服务端分页与详情按需加载

## Goal

将用户、平台管理员、团队、审计日志、应用版本和角色管理从固定上限加客户端分页迁移为服务端分页与按需详情，降低首屏数据量并消除静默截断。

## Requirements

- Users/Admins 复用分页用户 endpoint，按 `platformRole` 在数据库过滤。
- 用户列表只返回摘要；登录历史、团队关系和钱包流水在详情 Tab 打开时分页加载。
- Teams 列表不 include 全部 memberships/users；创建或分配成员时才加载用户 options。
- 团队 overview 与 members/roles/plugins/purchases/ledger 分开加载，未打开 Tab 不请求。
- Audit list 不返回完整 metadata；点击行才加载详情。
- Releases list 不返回 notes/assets；点击后加载详情。
- Roles 服务端分页，列表只返回 permissionCount；权限注册表和权限组只在创建/编辑器打开时加载。
- Tickets 保持现有服务端分页，只补快速切换详情的取消/乱序保护。
- Tickets 回复/改状态直接消费 mutation 返回的完整详情，不再额外 GET 同一工单。
- Users/Admins/Teams 只保留与后端软禁用/停用语义一致的动作，不展示“永久删除”误导文案。
- 所有列表具备独立 loading/error/empty/retry，并使用共享受控 Pagination。

## Acceptance Criteria

- [x] 上述无界列表响应均含 `items/total/page/pageSize`，无固定 200 条静默截断。
- [x] 列表 query 使用 select，不含密码、token、完整关系、大 metadata、notes 或 assets。
- [x] Users/Admins 过滤发生在数据库，不先下载全部用户。
- [x] Teams 首屏不请求全部 users，不 include memberships；详情隐藏 Tab 零请求。
- [x] Audit 和 Releases 点击前不请求详情。
- [x] Roles 编辑器关闭时不请求权限字典。
- [x] 快速切换实体不会串详情。
- [x] 工单 mutation 后没有重复详情 GET；软停用动作无“永久删除”文案。
- [x] 相关 backend tests/typecheck/build 和 admin typecheck/build 通过。

## Out Of Scope

- 改变用户、团队、角色和发布领域规则。
- 插件治理和计费模块列表。
