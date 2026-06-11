# summarizer 插件前端规范

## Scope

适用于 `plugins/summarizer/`。这是示例插件，展示 manifest、SDK 调用和 design token 消费方式。

## Pre-Development Checklist

- 改 manifest、能力声明或 UI 文件时，先读 [example-plugin.md](./example-plugin.md)。
- 同步读 `.trellis/spec/plugin-sdk/frontend/sdk-runtime.md` 和 `.trellis/spec/ui-tokens/frontend/tokens.md`。

## Quality Check

目前没有单独测试脚本。修改后手动检查：
- `manifest.json` 的 `entry` 指向存在文件
- 声明的 capability 与 UI 中 SDK 调用一致
- UI 不持有 API key，不直连网络
