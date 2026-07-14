# AI 换装测试插件（ai-outfit-test）

测试平台「带参考图的图片编辑」能力（`image.edit`）。上传目标模特图与服装参考图，经平台本地桥调用图片编辑接口生成换装/换内搭/换头等结果。模型调用全部走平台，按团队灵石计费，**无需配置任何密钥**。

> 定位：测试插件。从原「AI 换装稳定版」桌面脚本裁剪而来，只保留核心换装流程用于验证平台 `image.edit` 端到端通路与计费。生产化（多人/裂变/批量/任务队列）不在本插件范围。

## 能力说明

- `image.edit` —— 携带参考图（`image[]`）+ prompt，走平台 relay `/api/relay/v1/images/edits`（multipart 透传，按张计费）。上游模型名由 relay 按命中渠道注入，桥只传平台档位 `fast` / `premium`。

## 运行原理

桌面壳以 `nodejs` 运行时启动本进程时，注入两个环境变量：

| 环境变量 | 含义 |
| --- | --- |
| `LINGFANG_PLUGIN_BRIDGE_URL` | 本地桥基础地址，如 `http://127.0.0.1:<port>` |
| `LINGFANG_PLUGIN_BRIDGE_TOKEN` | 当前插件进程的短期会话 token |

脚本不持有用户 JWT 或上游密钥。把 token 放进请求头 `X-LingFang-Plugin-Token`，POST 到桥路由：

- `POST <BRIDGE_URL>/image/edit` —— body `{ prompt, images:[{filename,mimeType,data(base64)}], model, n, size }`，返回 `{ images: [url|data:base64...] }`

桥校验 `manifest.json` 声明的 `image.edit` 能力，解码 base64 重建 multipart，转发到平台 relay；relay 按命中渠道注入上游 model 并透传到上游 `images/edits`，按张扣当前团队灵石。

> 这正是 `@lingfang/plugin-sdk` 的 `sdk.image.edit` 在脚本运行时下的底层实现（见 `packages/plugin-sdk/src/index.ts` 的 `invokeScriptBridge`）。本插件为清晰演示把桥客户端逻辑直接内联，实际开发可直接 `import { sdk } from '@lingfang/plugin-sdk'`。

## 运行方式

在桌面客户端「插件中心」安装/导入本插件后点击「运行」。启动后自动打开本地网页 `http://127.0.0.1:<port>`：上传图1（模特/目标）与图2（服装/参考），选择预设或自填提示词，选档位/尺寸/数量，点「生成换装」即可。

> ⚠️ 直接 `node index.js` 无法运行：环境变量由桌面壳注入，脱离客户端时缺桥地址/token。

## 文件

- `manifest.json` —— 清单（声明 `image.edit`）
- `index.js` —— Node.js 内置模块 HTTP 服务 + 桥客户端 + 演示网页

## 依赖

仅 Node.js 内置模块（`http` / `net` / `child_process`），sandbox 无 `node_modules` 也可运行。

## 提示词预设

来源于原换装稳定版模板，仅保留测试用核心几条：换装、换内搭、换头、精修口令、创意。可在网页提示词框内自由编辑。
