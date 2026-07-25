# 插件开发指南

这套指南面向使用 `@lingfang/plugin-sdk` 和 `lingfang-plugin` CLI 的插件作者。最短路径是：创建工程、校验清单、构建 v4 制品、发布到注册中心。

```powershell
pnpm install
pnpm plugin:create demo --runtime client
pnpm plugin:validate .\demo
pnpm plugin:build .\demo
```

## 章节

- [Manifest 清单](./01-manifest.md)
- [运行时](./02-runtimes.md)
- [能力与权限](./03-capabilities.md)
- [SDK 调用](./04-sdk-usage.md)
- [本地开发](./05-local-dev.md)
- [构建与打包](./06-build-and-package.md)
- [发布与审核](./07-publish.md)
- [示例与排错](./08-examples-and-troubleshooting.md)
- [安全边界](./09-security.md)

CLI 和公开类型的逐项说明见 [SDK 使用指南](../sdk-guide/README.md)，HTTP 端点见 [API 参考](../api-reference/README.md)。
