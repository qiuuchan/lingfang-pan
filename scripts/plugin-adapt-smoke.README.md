# 灵坊插件「适配检验改造」流水线 · 脚本级端到端冒烟

`scripts/plugin-adapt-smoke.mjs` 把「样例插件 → 适配引擎改造 → 运行时确证 → 重打包 `.lfplugin` → 暂存适配报告 → 带留证发布」整条流水线用脚本跑通，验证桌面端 Rust 宿主（`plugin_adapt.rs`）调用的同一套引擎协议在脚本侧也能闭环，并抓「引擎判通过 ↔ 服务端后续关卡拒收」的集成缺陷。

## 前置条件

1. **collab-api 运行中**（默认 `http://localhost:19006`，可用 `API_BASE` 覆盖）。
   - 演示团队 / demo-user 由 `scripts/_smoke-helpers.mjs` **幂等确保**，无需手动建。
   - 登录凭证内置在 `_smoke-helpers.mjs`：`admin@example.com` / `demo-user@lingfang.dev`。
2. **postgres（collab-api 依赖的库）运行中** —— 否则 `adminLogin` 阶段就会失败。
3. **适配引擎产物存在**：`packages/plugin-sdk/dist/adapt.mjs`。缺失时脚本会自动执行
   `node packages/plugin-sdk/scripts/build-adapt.mjs` 现打（单文件 ESM，已 gitignore）。
4. **内置运行时（可选，仅 `execute` 时需要）**：`apps/desktop/runtimes/{python,nodejs}`。
   缺省退回 `PATH` 上的 `python3` / `node`。

## 运行

```bash
# 三个 runtime（python / node / client）全跑，期望全绿（改造→确证→打包→留证→发布 闭环）
node scripts/plugin-adapt-smoke.mjs

# 只跑某个用例
node scripts/plugin-adapt-smoke.mjs --only python
node scripts/plugin-adapt-smoke.mjs --only node,client

# 额外跑已知集成缺陷探针（client-a4gap / node-sdk），命中记 DEFECT、退出码 2
node scripts/plugin-adapt-smoke.mjs --probes

# 只跑本地引擎，不碰服务端（无需起 collab-api）
node scripts/plugin-adapt-smoke.mjs --no-upload

# 跳过运行时确证（无内置运行时的机器）
node scripts/plugin-adapt-smoke.mjs --no-execute

# 保留临时工作区 / .lfplugin 产物，便于人工看 diff
node scripts/plugin-adapt-smoke.mjs --keep

node scripts/plugin-adapt-smoke.mjs --help
```

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 选中用例全部闭环 |
| 1  | 冒烟链路故障（引擎崩 / 留证失败 / 服务端不可达）—— 先修依赖 |
| 2  | 链路通但抓到集成缺陷（引擎判通过、服务端策略闸门拒收 / 改造产物语法损坏）—— 记缺陷待修 |

## 样例插件（`scripts/fixtures/plugin-adapt/`）

| 目录 | runtime | 故意保留的毛病 | 期望结果 |
|------|---------|----------------|----------|
| `python/` | python | 缺 `id/version/visibility/capabilities`、硬编码 `base_url`+`api_key`、有 `import requests` 却无 `requirements.txt` | A1+A3+A4×2+A5，确证通过，发布闭环 |
| `node/`   | nodejs  | `entry` 写成 `index.ts`（实为 `index.js`）、硬编码 `base_url`、缺 `id/version/visibility` | A1+A2_entry_default+A3+A4，确证通过，发布闭环 |
| `client/` | client  | 只给 `name`，其余全缺；HTML 内用 `window.__lingfangInvoke` | A1(全)+A3，确证通过，发布闭环 |
| `client-a4gap/` | client | **探针**：顶层 `const baseURL = "https://api.openai.com/v1"`（非对象属性） | 引擎 A4 产出非法 JS，引擎却仍判 `ADAPTED_PASSED` 且服务端接受发布 → DEFECT |
| `node-sdk/`     | nodejs  | **探针**：`package.json` 依赖 `@anthropic-ai/sdk` | 引擎判 `ADAPTED_PASSED`，服务端 `assertPluginAiPolicy` 以 `ai.sdk.third_party` 拒收 → DEFECT |

> 脚本每次跑会把 fixture 拷到临时目录并给 `manifest.name` 追加 `runId`（`SMOKE_RUN_ID` 或时间），
> 让 A1 派生的插件 `id` 唯一，避免撞上「该版本已经发布且不可覆盖」。改造与打包一律落在系统临时目录，不碰样例源码。
