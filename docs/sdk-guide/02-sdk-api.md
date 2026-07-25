# SDK API

主要分组：

| 分组 | 方法 |
|---|---|
| `sdk.fs` | `pick`、`read`、`write` |
| `sdk.net` | `fetch` |
| `sdk.clipboard` | `readText`、`writeText` |
| `sdk.storage` | `get`、`set` |
| `sdk.shared` | `get`、`set`、`compareAndSet`、`delete`、`list` |
| `sdk.system` | `info`、`screenshot`、`notify` |
| `sdk.llm` | `chat` |
| `sdk.image` | `generate`、`edit` |
| `sdk.video` | `generate` |
| `sdk.plugin` | `upload`、`submitMarketplace` |
| `sdk.ui` | `render` |
| `sdk.actions` | `call` |
| `sdk.artifacts` | `create`、`materialize`、`import` |

示例：

```ts
const picked = await sdk.fs.pick({ accept: ['.md'] });
const value = await sdk.storage.get('draft');
const answer = await sdk.llm.chat({
  model: 'fast',
  messages: [{ role: 'user', content: String(value ?? '') }],
});
await sdk.system.notify('处理完成', answer);
```

SDK 不导出原始 `invoke`，插件不能通过任意字符串绕过类型化分组。
