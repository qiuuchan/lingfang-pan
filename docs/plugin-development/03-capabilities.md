# 能力与权限

插件必须先在 `manifest.json` 声明能力，宿主才会开放对应桥接入口。当前能力集合：

- UI 与存储：`ui.view`、`storage.kv`
- 文件：`fs.pick`、`fs.read`、`fs.write`
- 网络与剪贴板：`net.fetch`、`clipboard`
- 系统：`system.info`、`system.screenshot`、`system.notify`
- AI：`llm.chat`、`image.generate`、`image.edit`、`video.generate`
- 发布：`plugin.upload`、`plugin.submitMarketplace`

每项声明包含 `reason`、`risk`、`requires_admin` 和可选 `scope`。能力名不是提示文本，而是跨 contract、服务端白名单、桌面桥和 SDK 的稳定契约。

AI 能力只接收平台模型档位，例如 `fast` 或 `premium`。插件不得传递供应商地址、上游模型名、API Key、Authorization 或计费参数。
