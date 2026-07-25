# Manifest 校验器

```ts
import { validateManifest } from '@lingfang/plugin-sdk/manifest';

const result = validateManifest(JSON.parse(source));
if (!result.success) {
  for (const issue of result.errors) {
    console.error(issue.code, issue.path, issue.message);
  }
}
```

`validateManifest(input)` 先运行 `@lingfang/contract` 的 Zod schema，再运行 SDK 业务规则。返回联合类型：

```ts
type ManifestResult =
  | { success: true; manifest: PluginManifest }
  | { success: false; errors: ManifestError[] };
```

CLI 的 `validate` 和 `build` 使用同一入口，因此程序化校验与发布前校验不会漂移。
