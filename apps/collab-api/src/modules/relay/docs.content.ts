// 中转接入文档（markdown），由 /api/admin/billing/relay-docs 返回，管理端 + 前台用 <Markdown> 渲染。
// AI 插件开发者直接照抄本文档接入平台 AI 服务（需求 #4）。
export const RELAY_DOCS_MARKDOWN = `# 灵坊平台 AI 服务接入文档

灵坊平台提供 **OpenAI 兼容** 与 **Anthropic 兼容** 两套中转协议。所有 AI 调用（对话、生图）必须经平台中转，按团队灵石（Credit）账户按量计费，调用明细全程可查。

## 1. 接入准备

1. 在桌面客户端「设置 → 模型与计费」创建一把 **API Key**（明文仅显示一次，请妥善保管）。
2. API Key 形如 \`lf_<32hex>\`，归属你当前团队，消费扣该团队灵石。

## 2. Base URL

\`\`\`
{你的后端地址}/api/relay/v1
\`\`\`

例如本地开发：\`http://127.0.0.1:19006/api/relay/v1\`

## 3. 鉴权

所有请求带 \`Authorization\` 头：

\`\`\`
Authorization: Bearer lf_xxxxxxxxxxxxxxxx
\`\`\`

> 也可用登录态 JWT 调用（桌面端内部走此路径），外部脚本/插件请用 API Key。

## 4. 模型版本

平台**只提供两个固定版本**，\`model\` 字段取值：

| 取值 | 含义 |
|------|------|
| \`fast\` | 快速版（底层模型由后台配置，如 gpt-4o-mini） |
| \`premium\` | 高级版（底层模型由后台配置，如 claude-sonnet） |

不支持自定义模型 id。后台可随时调整两个版本对应的底层模型、参数与单价，前台无感。

## 5. 对话：OpenAI 协议

\`\`\`bash
curl -N {后端}/api/relay/v1/chat/completions \\
  -H "Authorization: Bearer lf_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "fast",
    "messages": [{"role":"user","content":"你好"}],
    "stream": true
  }'
\`\`\`

\`stream:true\` 时返回标准 SSE 流，末尾事件含 \`usage\`（计费依据）。

## 6. 对话：Anthropic 协议

\`\`\`bash
curl -N {后端}/api/relay/v1/messages \\
  -H "Authorization: Bearer lf_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "premium",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"你好"}]
  }'
\`\`\`

## 7. AI 生图

\`\`\`bash
curl {后端}/api/relay/v1/images/generations \\
  -H "Authorization: Bearer lf_xxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "premium",
    "prompt": "一只穿和服的猫",
    "n": 1,
    "size": "1024x1024"
  }'
\`\`\`

按张计费（单价后台配置）。

## 8. 计费规则

- **对话**：按 token 计费（输入/输出，每 1k token 若干灵石，后台按模型配置）。
- **生图**：按张固定计费。
- **固定动作**：按次固定计费（如创建插件会话）。
- 每次调用先按版本预扣一个「上限额度」（保护用户），结束后按实际用量冲销，多退少补（上限内）。
- 团队灵石余额不足时返回 \`402 insufficient_balance\`。

## 9. 错误码

| HTTP | code | 说明 |
|------|------|------|
| 401 | \`api_key_invalid\` | API Key 无效或已过期 |
| 403 | \`api_key_disabled\` | API Key 已被吊销 |
| 403 | \`capability_denied\` | API Key 的 scopes 不含本次能力 |
| 402 | \`insufficient_balance\` | 团队灵石余额不足 |
| 400 | \`bad_request\` / \`unsupported_model\` | model 非 fast/premium |
| 503 | \`no_channel_available\` | 无渠道可服务该团队/版本 |
| 502 | \`upstream_llm_error\` | 上游模型调用失败 |
| 503 | \`pricing_not_configured\` | 该模型未配置定价 |

## 10. 插件 SDK（推荐）

插件作者优先用 \`@lingfang/plugin-sdk\`，无需手动拼请求：

\`\`\`ts
import { sdk } from '@lingfang/plugin-sdk';
// 对话
const reply = await sdk.llm.chat({ messages: [{role:'user', content:'你好'}], model: 'fast' });
// 生图（能力授权后）
const images = await sdk.image.generate({ prompt: '一只猫', model: 'premium' });
\`\`\`

> 系统提示词已由平台统一注入：「凡涉及 AI 生图或其他 AI 能力调用，必须且仅能使用灵坊平台提供的服务，禁止使用任何其他第三方或自定义接口。」
`;
