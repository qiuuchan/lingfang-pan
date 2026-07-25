# 安装与导入

仓库内包通过 pnpm workspace 使用：

```json
{
  "dependencies": {
    "@lingfang/plugin-sdk": "workspace:*"
  }
}
```

TypeScript 插件：

```ts
import { sdk, PluginAiError, PluginActionError } from '@lingfang/plugin-sdk';
import { validateManifest } from '@lingfang/plugin-sdk/manifest';
import type { ClientPluginEntry } from '@lingfang/plugin-sdk/types/client-entry';
```

Client iframe 也可使用宿主注入的 `window.sdk`。类型声明中的 `ClientPluginEntry` 与导出的 `sdk` 保持同形。
