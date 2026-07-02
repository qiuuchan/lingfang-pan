# AI 能力演示插件（ai-demo）

演示 **Node.js 脚本插件**如何经「平台本地桥」安全调用平台 AI 能力（`llm.chat` 大模型对话、`image.generate` 生图），无需插件自带任何 API Key。

## 能力说明

- `llm.chat` —— 调用平台大模型（fast 档），发一句「say hi」并展示回复。
- `image.generate` —— 调用平台生图（fast 档），生成一张「橙色小猫简笔画」并展示。

## 运行原理

桌面壳以 `nodejs` 运行时启动本进程时，会注入两个环境变量：

| 环境变量 | 含义 |
| --- | --- |
| `LINGFANG_PLUGIN_BRIDGE_URL` | 本地桥基础地址，如 `http://127.0.0.1:<port>` |
| `LINGFANG_PLUGIN_BRIDGE_TOKEN` | 一次性会话 token（`lfpb_...`） |

脚本不持有用户 JWT / 平台 API Key。调用时把 token 放进请求头 `X-LingFang-Plugin-Token`，POST 到桥的对应路由：

- `POST <BRIDGE_URL>/llm/chat` —— body `{ messages, model }`，返回 `{ content }`
- `POST <BRIDGE_URL>/image/generate` —— body `{ prompt, model, n, size }`，返回 `{ images: [url|data:base64...] }`

桥校验 `manifest.json` 中声明的能力（`llm.chat` / `image.generate`），再以宿主登录态转发到平台 relay（`/api/relay/v1/...`），计费扣团队灵石。`capabilities` 未声明对应能力会被桥以 `403 capability_denied` 拒绝。

> 这正是 `@lingfang/plugin-sdk` 的 `sdk.llm.chat` / `sdk.image.generate` 在脚本（Node/Python）运行时下的底层实现（见 `packages/plugin-sdk/src/index.ts` 的 `invokeScriptBridge`）。本插件为清晰演示把桥客户端逻辑直接内联，实际开发可直接 `import { sdk } from '@lingfang/plugin-sdk'`。

## 运行方式

在桌面客户端「插件中心」安装/导入本插件后点击「运行」。启动后会自动打开本地网页 `http://127.0.0.1:<port>`，点击按钮即可实调平台 AI。

> ⚠️ 直接 `node index.js` 无法运行：环境变量由桌面壳注入，脱离客户端时缺桥地址/token。

## 文件

- `manifest.json` —— 清单（声明 `llm.chat` + `image.generate`）
- `index.js` —— Node.js 内置模块 HTTP 服务 + 桥客户端 + 演示网页

## 依赖

仅 Node.js 内置模块（`http` / `net` / `child_process`），sandbox 无 `node_modules` 也可运行。
