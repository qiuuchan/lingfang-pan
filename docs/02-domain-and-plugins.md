# 领域模型与插件

## 身份与团队

- `User`：登录身份、状态和 token 版本。
- `Team`：租户边界，拥有成员、余额、角色和插件包。
- `Role` / `PermissionEntry`：平台与团队两级 RBAC。
- `Membership`：用户与团队关系；当前团队决定大多数业务作用域。

## v4 插件注册中心

- `PluginPackage`：稳定包身份，以 `ownerTeamId + manifestId` 唯一。
- `PluginRelease`：不可变版本，保存 manifest、文件清单、制品 SHA、来源和审核状态。
- `MarketplaceListing`：市场货架，指向当前上架 release，并保存价格、分类、统计和质量快照。
- `PluginEntitlement`：团队对 package 的使用权。
- `Purchase`：购买、结算和退款记录。
- `PluginReleaseReview`：发行版审核历史。

旧插件记录只用于迁移兼容，不应成为新功能的数据源。新发布、审核、发现、购买和授权全部围绕 package/release/listing/entitlement 建模。

## Manifest

Manifest 字段和能力枚举以 `packages/contract/src/plugin.ts` 为准。运行时包括 `client`、`nodejs`、`python`、`cloud` 和 `workflow`；上传可见性只允许 `private` 或 `tenant`。

插件通过能力声明访问文件、网络、剪贴板、系统通知、AI、图片、视频、发布和共享状态。宿主会同时校验 manifest、团队权限和运行时 session。

## 制品与安装

`.lfplugin` v4 是确定性 ZIP，根目录必须有 `_meta.json` 与 `manifest.json`。桌面安装器先检查格式和 SHA，再安全解压到 staging，最后原子更新安装账本。更新先进入 pending release，成功启动后才激活，并保留一个 previous release 供回滚。

开发与打包见 [插件开发指南](./plugin-development/README.md)。
