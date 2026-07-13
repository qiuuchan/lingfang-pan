# 灵坊平台 · 计费系统与模型中转设计

本文描述当前平台托管模型、团队额度和插件 AI 调用边界。实际接口以
[协作 API](./collab-api.md) 为准，插件领域模型见
[领域与插件](./02-domain-and-plugins.md)。

## 1. 目标

- Chat 与图片生成统一经过 `collab-api` relay。
- 上游渠道地址、供应商凭证和真实模型只由平台管理员维护。
- 请求只使用登录会话 JWT 绑定的当前团队，并只扣该团队额度。
- 插件和终端用户不创建、填写、复制或持久化模型接入凭证与地址。
- 插件只可选择 `fast` / `premium` 平台档位，省略时默认 `fast`。

## 2. 总体架构

```text
桌面创建器 / Agent -------------------------------\
HTML 插件 -> iframe host bridge ------------------+-> collab-api relay
Node/Python 插件 -> localhost bridge + 一次性 token-/        |
                                                            v
                                                  JWT 当前团队校验
                                                            |
                                                  团队额度预扣与结算
                                                            |
                                                  团队渠道池与真实模型
```

本地 bridge token 只用于绑定受控插件进程与宿主会话，不是平台登录凭证，
不会被写入 manifest、插件设置、日志或持久化文件。

## 3. 数据模型

| 模型 | 职责 |
| --- | --- |
| `Channel` | 平台上游协议、地址、加密供应商凭证与路由状态 |
| `ChannelBinding` | 共享或团队专属渠道池绑定 |
| `ModelPricing` / `ModelTierConfig` | 平台档位、真实模型映射与计价 |
| `CreditAccount` / `CreditLedger` | 团队余额与不可变流水 |
| `LlmCallLog` | 团队、用户、能力、档位、渠道、用量、费用和客户端来源 |

调用日志不保存插件 bridge token、登录 JWT 或供应商凭证明文。

## 4. Relay

### 4.1 端点

- `POST /api/relay/v1/chat/completions`
- `POST /api/relay/v1/images/generations`
- `GET /api/relay/v1/models`

所有端点使用全局 JWT 鉴权和 `RelayTeamGuard`。守卫精确校验 JWT 中签名的
`teamId`、用户 ACTIVE membership、团队 ACTIVE 状态以及
`teamContextVersion`。不得按 membership 顺序重新推算团队，也不得在余额不足时
回退其他团队。

### 4.2 插件调用

- HTML/JavaScript 插件通过 `@lingfang/plugin-sdk` 调用
  `llm.chat` / `image.generate`。
- Node/Python 标准 OpenAI-compatible 客户端只能连接宿主注入的 localhost
  bridge URL，并使用一次性 bridge token。
- manifest 必须声明对应能力；AI 能力不触发管理员二次授权。
- 开发试跑与正式运行采用相同鉴权、渠道和扣费，仅通过 `clientSource` 区分遥测。

### 4.3 计费事务

1. 守卫确认 JWT 当前团队。
2. 服务端按能力与档位解析团队可用渠道和价格。
3. 从该团队账户预扣额度。
4. 调用上游并记录实际用量。
5. 成功时结算差额；失败时按规则退款。

`plugin_test`、`plugin_runtime` 和 `platform` 只用于调用来源统计，不参与授权、
渠道选择或计费归属。

## 5. 插件 AI 政策

服务端上传、发布、存量盘点与桌面安装/试跑/首次运行使用同一政策规则：

- 拒绝插件配置模型凭证、服务地址、provider、Authorization header 或真实模型名。
- 拒绝已知第三方模型 SDK、端点和硬编码模型 secret。
- 标准客户端必须实际绑定宿主 bridge URL/token，不能提供 fallback。
- `manifest.entry` 始终作为 UTF-8 可执行文本扫描；缺失、二进制、NUL、非法
  UTF-8 或超限时 fail closed。
- 政策结果按 `policyVersion + contentHash` 缓存；服务端仍是权威门禁。
- 存量失败版本被禁用或 yank；只能发布通过当前政策的新版本恢复。

## 6. 管理端

平台管理端保留：

- 渠道与资源池配置；
- 档位和模型定价；
- 团队余额调整与流水；
- 调用日志和客户端来源筛选。

团队端只展示额度与用量，不提供模型接入凭证或服务地址配置。

## 7. 数据库发布

PostgreSQL 使用分阶段迁移：先增加 JWT 团队上下文、调用来源和插件政策字段，
验证所有实例切换到 JWT-only relay 后，再执行已备份的数据清理迁移。

MySQL 使用生成 schema 与 `prisma db push`。涉及破坏性变更时必须由运维显式设置
一次性 `PRISMA_MYSQL_ACCEPT_DATA_LOSS_ONCE=1`；常规部署默认 fail closed。

## 8. 安全不变量

- 上游凭证明文仅在服务端渠道转发边界解密。
- 插件进程拿不到 JWT 或上游凭证。
- membership/团队上下文变化会使旧 JWT 与旧 bridge 会话失效。
- 产品错误可返回稳定 code、status、requestId；不得向插件泄漏上游内部信息或定价细节。
- 普通网络能力仍按既有 capability 管理；静态政策不承诺替代 OS 级网络沙箱。

## 10. 部署与初始化

部署顺序为 Prisma generate/validate、数据库迁移、确定性权限清理、RBAC/计费 seed，
然后运行存量插件 AI 政策盘点。盘点完成前，未通过当前政策版本的插件不可运行。

## 11.5.1 平台管理页面

计费区域包括渠道、资源池、定价、团队额度、流水和调用日志。调用日志展示
`platform` / `plugin_runtime` / `plugin_test` 来源，不展示任何接入凭证维度。

## 11.5.2 团队与桌面页面

团队页面展示当前团队余额和调用记录。插件创建器、预览和运行器只呈现平台档位与
产品错误，不出现模型凭证、地址或 provider 输入项。
