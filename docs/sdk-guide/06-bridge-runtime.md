# 桥接与运行时

Client 插件的默认桥是：

```ts
globalThis.__lingfangInvoke(capability, args)
```

桥缺失时 SDK 明确抛错，不提供假的本地实现。脚本插件由桌面宿主注入本地 HTTP 桥地址和一次性 token；OpenAI 兼容客户端可使用 `/v1/chat/completions`、`/v1/images/generations` 和 `/v1/models`。

桥负责：

- 校验 manifest 声明的能力；
- 将 AI 请求转发到平台 relay；
- 注入平台维护的供应商凭证；
- 执行团队计费、审计、退款与错误脱敏；
- 限制文件、网络和系统能力的作用域。

插件不得读取、打印、存储或展示桥 token，也不得要求用户输入平台内部 URL 或上游 API Key。
