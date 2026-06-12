# 云端插件分享

## Goal

补齐协作后端的插件云端分享能力：本地客户端创建成功的插件可以上传为团队共享插件，团队成员立即可见可运行；作者或团队管理员可以提交公共市场审核，平台管理员审核通过后所有团队可搜索、安装、使用。

## Confirmed Facts

- `apps/collab-api/src/modules/plugins.controller.ts` 当前只有 `GET /plugins/available`。
- `apps/collab-api/prisma/schema.prisma` 当前 `Plugin` 模型字段不足，无法保存源码、manifest、团队归属、审核状态和市场状态。
- `apps/collab-api/src/modules/collab.service.ts` 已有团队成员、团队管理员、平台管理员权限能力，可复用。
- 管理端已明确不允许直接创建插件，插件创建入口应来自本地客户端。

## Requirements

- 扩展云端 Plugin 模型，保存源码文件、manifest、capabilities、entry、版本、作者、团队、状态、审核状态和市场状态。
- 新增团队共享插件上传 API。
- 新增我的插件/团队插件查询 API。
- 调整可用插件 API，使其按当前团队返回团队共享插件和公共可用插件。
- 新增提交公共市场审核 API。
- 新增平台管理员审核通过/驳回 API。
- 所有写操作必须校验登录态、团队归属和角色权限。
- 上传必须校验 manifest、entry、文件路径、文件大小、capability 合法性。
- 所有关键行为写入审计日志。

## Acceptance Criteria

- [ ] `POST /api/plugins/upload` 可上传合法插件并返回云端 plugin id。
- [ ] 非团队成员不能上传团队插件。
- [ ] 非法 manifest、缺失 entry、非法路径、超限文件会失败并返回明确错误。
- [ ] `GET /api/plugins/mine` 返回作者插件和团队共享插件。
- [ ] `GET /api/plugins/available` 返回当前团队可运行插件。
- [ ] 作者或团队管理员可提交公共市场审核。
- [ ] 非作者/非团队管理员不能提交他人插件到市场。
- [ ] 平台管理员可查看待审核插件并通过/驳回。
- [ ] 审核通过后插件进入公共市场可见状态。
- [ ] 审核驳回后保存驳回原因。
- [ ] 后端类型检查和测试通过。

## Out Of Scope

- 不实现真实支付或提现。
- 不实现云端运行代码助手。
- 不实现跨团队共同编辑同一个插件。
