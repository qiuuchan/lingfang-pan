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

## 真机 GUI 端到端冒烟清单（有头环境照做）

> 把"导入 → 启动"整链路在无头环境无法覆盖的部分，固化为**照做即可执行**的人工清单。每条检查点写死"通过 = 什么现象"，避免真机测试主观化。与上一节无头单测互补：单测锁调用链，本清单验真机交互。
>
> **同一台有头真机一次跑完两个卡点**：① 导入→启动整链路；② P1-3 Batch A 的 `calculator`（Tkinter）弹窗 spike gate（见 d 节）。

### a. 前置（Prerequisites）

**构建**
- 仓库根执行 `cargo build -p lingfang-desktop`（桌面 crate 无 feature flag）。
  - 通过现象：`Finished` 无 error；产物 `target/debug/lingfang-desktop.exe` 生成（约 28.8MB）。Release：`cargo build -p lingfang-desktop --release` → `target/release/lingfang-desktop.exe`（约 11.4MB，首次因 `lto=fat` 较长）。
  - 记录本次 git rev：`git rev-parse --short HEAD` = `______`。
- ⚠️ `cargo build` **不会**自动准备嵌入式运行时，先跑：
  - `pnpm -C apps/desktop runtime:prepare`（从 `apps/desktop/runtime-parts/` 离线拼装 `node.exe`/`python/`/`chrome.dll`/`ffmpeg.exe` 等到 `apps/desktop/runtimes/`）。
  - `pnpm -C apps/desktop runtime:verify` → 控制台打印 `[runtimes] verified 3 key files (node=22.21.1, python=3.12.13+20260623, …)`。
  - 记录 `runtime-lock.json` 版本（见 `apps/desktop/runtimes/runtime-lock.json`）：node **22.21.1**（含 pnpm 9.15.9）、python **3.12.13+20260623**、ffmpeg 8.1.2、chromium 149.0.7827.55（rev 1228）、playwright 1.61.1。
- NSIS 安装包为 `installMode: currentUser`，**不触发 UAC 提权**；开发期直接跑 `target/debug/lingfang-desktop.exe` 即可。

**账户（UAC 双账户）** —— P1-3 隔离矩阵硬性要求
- 准备两个 Windows 账户：**标准用户**（非管理员）与**管理员**。
- 两个账户**各完整跑一遍**下面 b/c/d 的检查点（隔离策略在标准用户下才真实生效；管理员跑一遍确认不回归）。

### b. 逐步检查点（每步含"预期 / 通过现象"）

| # | 操作 | 预期现象 | 通过 = 具体现象 |
|---|------|----------|----------------|
| 1 | 智能体对话触发 `SearchGitHubProjects`（搜索 GitHub 仓库） | 返回候选仓库列表 | 聊天区出现 ≥1 张候选卡片，含 name/描述/语言/star |
| 2 | 候选呈现 | 卡片可点选 | 卡片渲染、可点"导入" |
| 3 | 调用 `ImportGitHubPlugin`（→ 后端 `import_github_repo(input:)` + `run_plugin_adapt(request:{mode:inPlace})`） | 仓库克隆并合成 manifest | 进度显示克隆完成；`plugins_root/workspaces/<uuid>/manifest.json` 落盘且 `draft:true` |
| 4 | 草稿面板出现 | 导入回调刷新草稿面板 | 插件列表出现该 `<uuid>` 草稿条目，runtime/entry 已合成（非 client 兜底） |
| 5 | 启动 `startPlugin(<uuid>)` | 签名门禁放行（attest 基线豁免） | `plugin:start-progress` 依次出现 `checking` → `deps_installing` → `starting` 三阶段动画 |
| 6 | 依赖安装日志回显 | venv/pip/pnpm 输出回流 | 日志面板实时出现 `Creating virtualenv` / `pip install` 或 `pnpm install` 逐行输出（对照 CHANGELOG 的驼峰修复） |
| 7 | 插件 UI/输出可见 | 进程常驻且输出可见 | client：iframe/UI 渲染；node/python：日志面板持续打印进程 stdout，`plugin:exited` 仅在手动停止时触发 |

> 注：`SearchGitHubProjects` 当前定位为"搜索并引导用 `ImportGitHubPlugin`"，真正落盘由 `ImportGitHubPlugin` 完成（见 `apps/desktop/src/lib/agent/tools.ts:1370` / `:1416`）。

### c. 失败路径采样（报错必须回流 UI）

| 场景 | 构造 | 通过 = 具体现象 |
|------|------|----------------|
| 入口缺失 | 导入一个**无入口文件、且仓库内也无候选入口**（如仅 README）的仓库 | `validate` 报 `entry_not_found`；UI 显红 / ErrorBubble；**启动被拦截，绝不空跑**（不出现"启动成功却什么都没发生"） |
| 依赖装不上 | 导入一个依赖装不上的仓库（如 `requirements.txt` 指向不存在的包 / 断网） | `deps_installing` 阶段后 `plugin:output` 出现安装失败日志；随后 `run_spawn_failed` / `plugin_crashed` 回流 UI，前端报错提示，进程不退避成静默成功 |

> 已知小缺口（非阻塞，留待后续）：`app.emit` 失败静默丢弃；`data/.launch.log` / `.crash.log` 未回流 UI；`plugin_runner::timed_out` 未被调用方读取；node 安装失败详情有时为空（未用 `captured_detail` 兜底）。

### d. 顺带验证：P1-3 Batch A spike gate —— `calculator`（Tkinter）弹窗

Batch A 的硬性门槛（不通过则回退）：隔离加固后，内置 `calculator`（Tkinter GUI，`apps/desktop/builtin-plugins/calculator/manifest.json`，`runtime_type: python`）**必须仍能弹出窗口**。`JOB_OBJECT_UILIMIT_DESKTOP` 与资源限制（64 进程 / 4GiB / CPU 80% / `UI_RESTRICTIONS_DEFAULT`）可能阻断窗口创建——若受阻，将其列入豁免或调低 UI 限制（见 `d:\lf-pan\P1-3-EXECUTION-ISOLATION-PLAN.md:89`）。

"UI 受限 Job" **不是用户配置项**，由 `SandboxPolicy::plugin_entry()` 自动施加（`apps/desktop/src-tauri/src/process_util/guarded_spawn.rs:116`）。逃生开关：`LINGFANG_SANDBOX_SOFT=1`。

| 步骤 | 操作 | 通过 = 具体现象 |
|------|------|----------------|
| d1 | 启动 app，打开 计算器 插件（**标准用户**账户下） | 进程以受限 Job 拉起，`plugin:start-progress` 走完 |
| d2 | 观察窗口 | **计算器 Tkinter 窗口实际弹出且可交互**（按键有响应） |
| d3 | 校对隔离未越界 | 插件进程不在默认桌面/剪贴板/句柄列表里（`guarded_spawn.rs` 断言 DESKTOP/clipboard/HANDLES 不泄漏） |
| d4 | **管理员**账户重复 d1–d3 | 同样弹窗成功，无回归 |
| d5（harness） | `python d:\lf-pan\.spike\job_ui_spike.py` | 子进程打印 `TK_OK mapped=… width=…`（非 `TK_FAIL:<reason>`）；结果见 `d:\lf-pan\.spike\job_ui_spike.result.txt` |

> **现状（2026-08-10 实测坐实，结论冲突已消除）**：spike gate 已在本机（Administrator 账户，Windows）实际跑通，原「计划标注未执行 vs guarded_spawn 声称 22 组全通过」的冲突以**实测全通过**收口：
> - **Tkinter（`job_ui_spike.py`，16 组）**：baseline / 仅 KILL_ON_CLOSE / 各 `UILIMIT_*` 位（**含 `DESKTOP`**）/ 资源配额（ActiveProcess=32、ProcessMemory=2GB、CpuRate=80%）/ 全套组合 —— 全 `TK_OK mapped=True width=240`。即 calculator 弹窗不受 UI 受限 Job 影响，`DESKTOP` 位在本机也未阻断 Tkinter。
> - **Playwright/Chromium（`pw_job_spike.py`，22 组）**：headless + headed 各 `UILIMIT_*` 位 + 资源配额 + 推荐组合 —— 全 `PW_OK`，Job 内峰值 **12** 活跃进程（远低于 64 上限，`qianniu-panel` 的 Chromium 嵌套 Job 不会打爆 `ACTIVE_PROCESS_LIMIT`）。
> - 结果文件：`d:\lf-pan\.spike\job_ui_spike.result.txt`、`pw_job_spike.result.txt`。
> **待补（UAC 双账户硬性要求）**：本机仅 Administrator 已验，**标准用户**账户下需再跑一次 d1–d4 确认不回归；若标准用户下 `DESKTOP`/clipboard 等行为与 Administrator 有差异，按 `P1-3-EXECUTION-ISOLATION-PLAN.md` 将 calculator 列入豁免或调低 UI 限制。

### 判定标准（总览）

- b1–b7 全通过 + c 两场景均"报错回流" → 导入→启动闭环 OK。
- d1–d4 在标准用户与管理员下窗口均弹出且隔离未泄漏 → Batch A spike gate 通过；任一账户弹不出 → **回退 Batch A**，按 `P1-3-EXECUTION-ISOLATION-PLAN.md` 将 calculator 列入豁免 / 调低 UI 限制。
- 任一条"通过现象"未出现即判失败，记录截图/日志后上报，**不得主观放过**。
