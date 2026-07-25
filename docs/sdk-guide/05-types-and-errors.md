# 类型与错误

包根导出 SDK 输入/输出类型，包括聊天、图片、视频、插件上传、动作调用、ArtifactRef 和共享状态类型。

AI 错误使用 `PluginAiError`，动作/制品错误使用 `PluginActionError`。两者都保留稳定 `code`、HTTP `status` 和安全的 `details`，调用方应优先按 `code` 分支。

```ts
try {
  await sdk.image.generate({ model: 'fast', prompt: '一只猫' });
} catch (error) {
  if (error instanceof PluginAiError && error.code === 'insufficient_balance') {
    // 引导用户充值，而不是解析中文消息。
  }
}
```

`ClientPluginEntry` 只提供类型，不产生运行时代码；它还为 `window.sdk` 和 `window.__lingfangInvoke` 提供全局声明。
