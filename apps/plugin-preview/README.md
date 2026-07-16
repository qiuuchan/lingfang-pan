# LingFang Plugin Preview Origin

独立、无 Cookie 的 Client 插件预览资源源。它不直接连接数据库，也不接收主站登录态；只使用服务端密钥向 collab-api 读取短期 `WebPreviewSession` 绑定的已审核精确发行版资源。

必需配置：

- `PLUGIN_PREVIEW_SERVICE_KEY`：与 collab-api 相同、至少 32 字符的服务间密钥。
- `PREVIEW_WEB_APP_ORIGINS`：允许嵌入预览的主站 origin，逗号分隔。
- `COLLAB_API_INTERNAL_ORIGIN`：collab-api 内部地址，默认 `http://127.0.0.1:3000`。
- `PLUGIN_PREVIEW_PUBLIC_ORIGIN`：生产预览源自身 origin，用于启动期校验它与主站不同。
- `PORT`：默认 `19007`。

反向代理不得给该 origin 注入主站 Cookie，也不要放宽服务返回的 CSP、Permissions-Policy 或 Referrer-Policy。
