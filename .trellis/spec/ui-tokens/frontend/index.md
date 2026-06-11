# @lingfang/ui-tokens 前端规范

## Scope

适用于 `packages/ui-tokens/`。这个包当前只有 `tokens.css`，不是 React 组件库。

## Pre-Development Checklist

- 改 design token 时，先读 [tokens.md](./tokens.md)。
- 同步检查 `plugins/summarizer/ui/index.html` 和生成插件 prompt 中对 token 的约束。

## Quality Check

没有单独构建脚本。修改后至少检查：
- `packages/ui-tokens/tokens.css`
- 插件示例是否仍能通过 `var(--lf-...)` 消费 token
