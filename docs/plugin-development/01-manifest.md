# Manifest 清单

插件根目录必须包含 `manifest.json`，字段使用 snake_case。契约真源是 `packages/contract/src/plugin.ts`，校验入口是 `validateManifest()`。

```json
{
  "id": "com.example.demo",
  "name": "Demo",
  "version": "0.1.0",
  "description": "示例插件",
  "runtime_type": "client",
  "entry": "ui/index.html",
  "visibility": "tenant",
  "capabilities": [
    {
      "kind": "ui.view",
      "reason": "展示插件界面",
      "risk": "none",
      "requires_admin": false
    }
  ]
}
```

规则摘要：

- `id` 以英文字母开头，仅使用字母、数字、点、下划线和连字符。
- `version` 必须是严格 SemVer，例如 `1.2.3`。
- `visibility` 只允许 `private` 或 `tenant`；公开上架由审核流程决定。
- `entry` 必须是包内相对路径，并与运行时匹配。
- `capabilities` 最多 64 项；每项需说明用途和风险。
- 可选 `actions`、`action_dependencies`、`shared_namespaces` 由共享契约继续校验。

运行：

```powershell
pnpm -C packages/plugin-sdk exec lingfang-plugin validate <插件目录>
```
