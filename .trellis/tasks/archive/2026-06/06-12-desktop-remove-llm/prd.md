# desktop 删除 LLM 链路

## Goal

桌面客户端已改用本地 code_assistant CLI 生成插件，删除所有指向云端 LLM 网关的前端链路。本任务仅限 desktop 客户端侧，server 端清理由子任务 D 处理。

## Parent

06-12-backend-collab-unification

## Requirements

- R1 删除死代码：`lib/stream.ts`（SSE 流式生成，Generator 已删后零引用）
- R2 删除 `lib/models.ts`（模型目录美化）与 `public/models-catalog.json`
- R3 删除 `public/gateway.config.json`
- R4 `pages/Settings.tsx` 移除"LLM 网关"卡片及其全部逻辑（`/llm-bindings`、`/llm/models`、`/llm/test`、GatewayConfig、binding/apiKey/model 状态），保留"后端服务地址"卡片
- R5 `lib/types.ts` 移除 `GatewayConfig` 接口
- R6 `lib/plugin-draft.ts` 的 `buildLocalDraft` 中 `capabilities: ['llm.chat']` 改为本地能力声明（如 `['code-assistant']`）
- R7 `pages/plugins-runtime.ts` 的 `llm.chat → /llm/proxy` 分支改为本地兜底（提示本地运行时不支持，或走 code_assistant），不再调云端 `/llm/proxy`
- R8 清理所有因删除产生的未使用 import

## Acceptance Criteria

- [ ] AC1 `lib/stream.ts`、`lib/models.ts`、`public/gateway.config.json`、`public/models-catalog.json` 不存在
- [ ] AC2 Settings 页只剩"后端服务地址"卡，无 LLM 网关相关 UI
- [ ] AC3 `rg "GatewayConfig|llm-bindings|/llm/|streamGenerate|loadModelCatalog|gateway.config" apps/desktop/src` 无结果
- [ ] AC4 `pnpm -C apps/desktop typecheck` 通过
- [ ] AC5 `pnpm -C apps/desktop vite:build` 通过

## Out of Scope

- server(Rust) 端 LLM 代码删除（子任务 D）
- collab-api 的 LLM 相关（collab-api 本就无 LLM 模块）
- wallet/market 迁移（子任务 B/C）

## Notes

- 保留 code_assistant 相关（本地 CLI，不是云端 LLM）
- 保留插件运行时其他能力（fs/ui/code-assistant）
