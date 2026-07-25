# SDK 调用

Client 插件通过宿主注入的 `globalThis.__lingfangInvoke(capability, args)` 调用能力；`@lingfang/plugin-sdk` 提供类型化封装。

```ts
import { sdk } from '@lingfang/plugin-sdk';

const result = await sdk.llm.chat({
  model: 'fast',
  messages: [{ role: 'user', content: '总结这段内容' }],
});

await sdk.storage.set('last-result', result.content);
```

脚本插件可通过宿主注入的本地桥地址和一次性 token 使用 SDK 的 HTTP fallback。插件代码不得显示、记录或持久化该 token。

完整 API 见 [SDK API](../sdk-guide/02-sdk-api.md)。
