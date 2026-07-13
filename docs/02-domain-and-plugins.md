# 领域模型与插件生命周期

> 本文描述当前领域模型。迁移前的草稿、LLM 绑定和旧后端模型仅保留在历史文档中。

## 领域边界

### 身份与团队

- `User` 表示账号。
- `Team` 是协作、余额、插件所有权和权限的主要租户边界。
- `Role`、`PermissionEntry` 和成员关系实现平台级与团队级 RBAC。
- 团队管理员申请有独立状态机和审计记录，不与插件审核共用数据库实体。

### 插件工作区

桌面工作区是正在创建或编辑的本地源文件集合，包含 manifest、入口文件和资源。创建器通过 Agent 工具读取、写入和验证工作区。工作区不是云端已发布发行版，也不能直接作为市场安装来源。

### 插件包与发行版

- `PluginPackage` 表示稳定插件身份和所有权。
- `PluginRelease` 表示不可变版本，关联 SemVer、manifest、文件清单、制品摘要、来源和审核状态。
- `MarketplaceListing` 表示市场上架状态，并通过 `currentReleaseId` 精确指向当前版本。
- `PluginReview` 和审计记录保存发行版治理过程。

同一包可有多个发行版，但市场当前版只能是 listing 指针指向的已批准发行版。下架保留发行版、制品、历史和既有权益。

## 运行时类型

| 类型 | 执行位置 | 说明 |
|---|---|---|
| `client` | 桌面 WebView/iframe | 纯前端插件，通过受控桥调用能力 |
| `python` | 桌面子进程 | 使用 Resolver 选定的 Python 与独立 venv |
| `nodejs` | 桌面子进程 | 使用 Resolver 选定的 Node 与隔离依赖目录 |
| `cloud` | 平台服务 | 由平台能力和契约约束，不在本地脚本进程执行 |

插件运行、创建、预览、依赖安装和 Agent shell 的执行来源必须是软件内置运行时，不探测或使用系统 Python/Node/FFmpeg/Chromium。

## 创建与发布

```text
自然语言需求
  -> Agent 会话
  -> 本地工作区文件
  -> manifest / 完整性 / 安全校验
  -> 本地预览
  -> 确定性 .lfplugin 制品
  -> package release
  -> 平台审核
  -> marketplace listing
  -> 桌面安装与原子激活
```

发布边界会重新验证插件 ID、版本、入口、能力、文件路径、数量、大小和摘要。服务端不信任桌面端已经执行过的校验。

## 安装与本地状态

桌面端把远端发行版安装到不可变 release 目录，并用安装账本记录活动版、待激活版和来源。下载、摘要校验或依赖准备失败时不得覆盖当前活动版本。用户从已安装插件复制到工作区后，副本重新成为可编辑本地源。

## 模型与计费

插件和创建器通过平台 relay 使用 `fast` / `premium` 等产品层级，不直接获取上游渠道密钥。后端负责渠道选择、调用记录、灵石预留/结算和错误映射。团队余额、账本和平台上游渠道凭证属于平台领域，不属于插件 manifest。

## 治理规则

- 审核状态转换使用条件更新，两个并发处理请求只能有一个成功。
- 驳回和下架必须记录原因。
- 列表只返回摘要；manifest、文件元数据和审核历史在详情 Tab 中按需加载。
- 管理端不返回插件文件正文、上游密钥密文或其他敏感字段。

## 契约来源

- 插件和 manifest：`packages/contract/src/plugin.ts`
- 插件治理：`packages/contract/src/plugin-registry.ts`
- 后端模型：`apps/collab-api/prisma/schema.prisma`
- 桌面安装状态：`apps/desktop/src-tauri/src/plugin_package_manager.rs`
