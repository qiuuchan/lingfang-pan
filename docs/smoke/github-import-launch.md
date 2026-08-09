# 灵坊插件「GitHub 导入 → 启动」· 冒烟说明

P2 打通了**智能体侧 GitHub 搜索 / 导入**（落盘为 `workspaces/<uuid>` 草稿工作区 + 合成 `manifest.json` + 写入 `attestation` 基线），P3 闭合了**启动**这一段：导入的草稿工作区能被桌面端 `startPlugin` 正常解析并 launch，而不是仅「落盘成功」。

本文记录这条闭环的关键链路、无头环境能覆盖到的部分、以及**真机 GUI 端到端仍是已知卡点**。

## 闭环链路（导入 → 启动）

```text
import_github_repo (input:)
  └─> 克隆到 plugins_root/workspaces/<uuid>
  └─> run_plugin_adapt (request: { mode: inPlace })  合成 manifest.json（覆盖而非沿用仓库自带值）
        - A1 缺字段补齐 / A2 入口对齐 / A3 能力探测 / A4 AI 边界 / A5 依赖归一
        - 真实入口缺失时先扫仓库内候选（src/server.js 等），找不到才生成最小骨架（防空壳）
  └─> set_plugin_draft_flag(<uuid>, true)   ← P2 Step 3
        - 改写 manifest.draft=true
        - mark_manifest_attestation 写入 plugins_root/.lingfang/attest/<dir-sha>.json（框架侧草稿基线）

startPlugin(<uuid>)
  └─> plugin_store::plugin_dir(<uuid>)   workspaces/<uuid> 优先解析
  └─> enforce_signature_gate(root, dir, require_signed=true)
        - 自述 draft 不足以豁免（防自我提权）
        - 命中 set_draft_flag 写入的 attestation 基线 → 草稿豁免放行
  └─> ensure_python_venv / ensure_node_dependencies   （仅嵌入式运行时，自动装依赖）
  └─> 常驻 + plugin:start-progress / plugin:output 复用进度与日志
```

## 无头环境能覆盖到的（已用单测定锁）

| 环节 | 锁定点 | 测试 |
|------|--------|------|
| 工作区优先解析 | `plugin_dir` 在 `workspaces/<uuid>` 存在时返回它；否则回退 `<root>/<uuid>` | `plugin_store::tests::plugin_dir_resolves_workspaces_first` / `plugin_dir_falls_back_to_root_level_when_no_workspace` |
| 导入草稿可被启动 | 导入落盘 + `set_draft_flag(true)` 后，`enforce_signature_gate(root, dir, true)` 放行 | `plugin_security::tests::imported_workspace_draft_exempts_at_launch` |
| 反向护栏 | 未走授权通路（无 attest 基线）的自述 draft 工作区在 `require_signed=true` 必须被拒 | `plugin_security::tests::unbaselined_draft_workspace_rejected_at_launch` |
| 入口空壳防护 | nodejs 真实入口在 `src/server.js`（无 `index.js`）时指向它、不生成空壳；python 同理；仅当仓库内确实无入口才生成骨架 | `packages/plugin-sdk/src/adapt/__tests__/adapt.spec.ts` → `describe('P3 A2 入口候选探测')` |

运行：

```bash
# Rust（桌面宿主）
cd apps/desktop/src-tauri
cargo test --bin lingfang-desktop -- plugin_dir_resolves_workspaces_first imported_workspace_draft_exempts_at_launch unbaselined_draft_workspace_rejected_at_launch

# TS（适配引擎 A2 改造）
cd packages/plugin-sdk
npx vitest run src/adapt/__tests__/adapt.spec.ts -t "P3 A2"
```

## 失败路径可观测性

无入口 / 依赖装不上等失败，`plugin_runner` 通过 `plugin:output`（逐行日志）、`run_spawn_failed` / `plugin_crashed` 等回传 UI，已在代码路径上确认。已知小缺口（非 P3 阻塞，留待后续）：

- `app.emit` 失败被静默丢弃；
- `data/.launch.log` / `.crash.log` 未回流到 UI；
- `plugin_runner::timed_out` 未被调用方读取；
- 节点依赖安装失败时错误详情有时为空（未用 `captured_detail` 的 stdout 兜底）。

## 已知卡点：真机 GUI 端到端

**导入 → 启动的整链路真机 GUI 冒烟在无头环境无法覆盖**（需真实 WebView / 桌面窗口交互）。当前以单测锁定调用链（上表），真机验证需在有显示环境的机器上手动完成：

1. 智能体侧触发 GitHub 导入 → 确认 `workspaces/<uuid>` 落盘、`manifest.json` 合成、`attest` 基线写入；
2. 在插件列表看到草稿 → 启动 → 确认进度/日志回流、进程常驻；
3. 反向：人为截断 `set_draft_flag` 或赋错 `uuid` → 确认启动被签名门禁拦截。
