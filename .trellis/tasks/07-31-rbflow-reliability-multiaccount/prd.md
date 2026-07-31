# RBFLow 可靠性与多账号改造

## Goal

修复 `plugins/rbflow-video` 插件 + `P:\RBFLow` 后端在工作流任务执行中的可靠性问题（超时误杀、提交卡死、状态不同步），并新增多 RunningHub 账号池、阶段化任务管理、独立配置页等能力。目标：任务能稳定跑完、UI 不卡、状态准确、可横向扩容 RB 账号。

## Background / 涉及代码库

本任务横跨三个代码库，改动前必须认清边界：

1. **`P:\lingfang-platform\plugins\rbflow-video\main.py`** — PySide6 桌面插件（用户侧）。`main.py` 3648 行。
2. **`P:\RBFLow\`** — FastAPI 后端（`app/`）+ React 管理前端（`frontend/src/`）。独立 git 仓库。
3. **`P:\lingfang-platform\apps\desktop`** — 平台桥（Rust，`plugin_llm_bridge.rs` 等），插件经桥代理调用 RBFLow。

**安全边界（不可破坏）**：插件进程只有 `LINGFANG_PLUGIN_BRIDGE_URL/TOKEN`，**不持有任何 RunningHub 凭证**。所有 RB 调用经平台桥 → RBFLow 后端。多账号（RB API key）只活在 RBFLow 后端，插件无感。用户物理上无法绕过灵石计费直连 RB。

调用链：插件 → 桥 `/video/generate`、`/video/stream`、`/video/download` → RBFLow `/tasks/*` → RunningHub OpenAPI。

## 核心决策（用户已确认 2026-07-31）

1. **轮询频率**：向 RunningHub **每 5 分钟查询一次**任务状态（降低请求量），间隔可在管理后台配置。
2. **进度条**：**假性进度**（按阶段 + 时间估算平滑推进），不追求实时；每次轮询把真实状态/阶段拉回对齐。
3. **硬超时**：**去掉** `task_timeout_sec` 硬上限，持续轮询直到 RB 给出真正终态（SUCCESS 有产物 / FAILED）。
4. **实时进度 WS**：**整条链路删除**（后端 `monitor_progress` + 前端 `ProgressMonitor.tsx` + 插件 WS 相关代码），统一走轮询。
5. **多账号**：后端做成 RB API key 池，每 key 并发上限默认 3（可配），新任务分配给当前最闲的 key。
6. **配置**：RBFLow 管理后台新增**独立配置页**（轮询间隔、多账号 key 池、每账号并发、超时/重试等）。
7. **任务展示**：管理后台任务管理按**阶段**呈现：排队 / 上传 / 运行 / 完成（+ 失败），靠向 RB 查询更新。

## Requirements（原始 9 项 + 新增，合并归类）

### R1. 去硬超时 + 5 分钟轮询到终态（原 #1）
- 移除 `orchestrator._poll_outputs_with_grace` 里 `run_deadline = now + task_timeout_sec` 的强制放弃逻辑。
- 运行阶段轮询间隔默认 300s（可配），仅当 RB 报告 SUCCESS(有产物) / FAILED 才终止。
- 保留 grace window（SUCCESS-with-empty-outputs / FAILED 后等 CDN 上传）但 grace 也应可配且不再被硬上限截断。

### R2. 删除 WS 实时进度链路（原 #7）
- 后端：移除 `RunningHubClient.monitor_progress` 的调用点与 `_obtain_wss_with_retry`/`_try_get_wss`（或保留 client 方法但不再用于编排）。
- 前端：移除 `ProgressMonitor.tsx` 页面与路由、导航入口。
- 插件：移除 `ProgressWorker`（长驻轮询）相关 WS/实时路径，统一改为定时状态拉取。

### R3. 假性进度模型
- 进度按阶段权重 + 时间线性推进（复用既有 `ProgressEstimator` 的线性 ramp），WS 输入移除后仍能走动。
- 每次轮询用 RB 真实状态对齐阶段、回填进度锚点；进度条永不卡死、最终落到 100%（成功）或停在失败前值。

### R4. 多 RB 账号池 + 每账号并发门（原 #3、#4）
- RBFLow 后端支持配置 N 个 RB API key；每个 key 维护并发计数，上限默认 3（可配）。
- 新任务分配策略：选当前并发数最低（且未满）的 key；全满则在本地队列排队（不提交 RB），等空位。
- 现有 `asyncio.PriorityQueue` 本地队列保留，作为"全账号满"时的排队层；421 退避与本地并发门联动（本地已限流则不会触发 421，但保留 421 兜底）。
- 账号与并发配置存 `config.yaml`（持久默认）+ `data/queue_state.json`（运行时覆盖）+ 管理后台可改。

### R5. 提交/状态链路可靠性（原 #2）
- **提交即入本地队列**：插件 → 桥 → RBFLow `/video/generate` 必须快速返回 `task_id`（入本地队列即返回），不得阻塞到 RB create 完成。
- 插件提交超时与后端实际进度解耦：即便插件侧请求超时，后端任务继续；插件重进能找回真实状态。
- 状态同步：插件按 5 分钟（可配）经桥拉取任务状态，展示假进度；不再长阻塞 `/stream`。
- **需研究**：定位当前"提交失败但还在生成""UI 卡死"的精确阻塞点（桥 `plugin_llm_bridge.rs` / RBFLow `tasks.py` / 插件 `bridge_*`），在子任务 C 的 research/ 阶段产出。

### R6. 阶段化状态语义 + 透传（原 #5）
- 明确四阶段：`排队`（本地队列 + RB 队列）→ `上传`（UPLOADING）→ `运行`（RUNNING）→ `完成`（SUCCESS），另 `失败`（FAILED）。
- 后端 `/tasks` 列表与单任务接口返回 `phase`（或等价字段），供前端与插件显式区分"本地排队中"与"已提交 RB"。

### R7. 独立配置页（管理后台）（原 #6）
- RBFLow 管理前端新增独立「设置」页：轮询间隔、多账号 key 池（增删改、并发上限、启用状态）、failure_grace、421 退避、http 超时/重试等。
- 后端新增/扩展读写配置的 API（含 key 校验：调用 RB ping）。

### R8. 仪表盘 + 任务管理数据增强（原 #9）
- 仪表盘：总任务数、各阶段数、成功率、平均耗时、各 RB 账号并发占用/吞吐等。
- 任务管理：显示 rh_task_id、所属账号、阶段、耗时、重试次数、错误码等更详细列。

### R9. 插件侧改造（原 #5、#8，R5 插件侧）
- 任务卡片显示任务 id（`rbflow_task_id`）。
- 区分"本地排队"/"已提交"。
- 假进度条 + 5 分钟状态拉取（与后端一致）。
- 修复卡死/同步问题（与 R5 联动）。

## Constraints

- **不破坏计费安全边界**：插件不得获取 RB 凭证；扣灵石仍由桥在提交前完成。
- **跨库协调**：桥（Rust）与 RBFLow（Python）接口变更需同步；RBFLow 是独立仓库，改动单独提交。
- **向后兼容**：`tasks.json`（插件）、`data/tasks.db`（后端）老数据需平滑迁移（新字段走默认值）。
- RBFLow 后端默认部署仍能在单账号下工作（多账号是 N=1 的特例）。

## Task Map（子任务）

| 子任务 | 范围 | 覆盖需求 | 依赖 |
|--------|------|---------|------|
| **A. 后端进度链路重构** | `P:\RBFLow\app\core\orchestrator.py` + `runninghub.py` + `settings.py` | R1, R2 后端, R3 | — （地基） |
| **B. 多 RB 账号池 + 并发门** | `P:\RBFLow\app\core\queue.py` + `runninghub.py` + `settings.py` + 配置 API | R4 | A（共用 settings/runtime 模型） |
| **C. 提交/状态链路可靠性** | 桥 `plugin_llm_bridge.rs` + RBFLow `app/api/tasks.py` + 插件 `bridge_*`（先 research） | R5 | A（状态模型） |
| **D. 管理后台：配置页 + 阶段化任务管理 + 仪表盘** | `P:\RBFLow\frontend\src\components\pages\*` + 后端配置/统计 API | R6 后端字段, R7, R8 | A、B（消费新状态/账号字段） |
| **E. 插件改造** | `plugins/rbflow-video/main.py` | R6 插件侧, R9, R2 插件侧, R5 插件侧 | A、C（状态/同步模型） |

A 是地基（新进度/状态模型），D、E 消费 A 的产物；C 与 E 强相关（提交/同步两侧同改）；B 相对独立但与 A 共享 settings。

## Cross-Child Acceptance Criteria

- [ ] 一个视频任务提交后，即便 RB 实际跑了 >30 分钟，后端也**不会**因本地硬超时判失败（R1）。
- [ ] 全链路无 WS 实时进度代码残留（后端不再 `monitor_progress`、前端无 ProgressMonitor 页、插件无 ProgressWorker）（R2）。
- [ ] 进度条在 5 分钟轮询间隔内仍平滑前进，不卡死；成功落到 100%（R3）。
- [ ] 配置 2 个 RB key、每账号并发 2，提交 5 个任务：前 4 个立即提交（2×2），第 5 个停在「本地排队」，某个任务完成后第 5 个自动提交（R4）。
- [ ] 插件提交即便请求层超时，后端任务仍在跑；重进插件能看到真实阶段与状态，不卡 UI（R5/R9）。
- [ ] 管理后台有独立设置页可改轮询间隔、账号池；任务管理显示阶段、rh_task_id、所属账号等（R6/R7/R8）。
- [ ] 插件任务卡片显示任务 id 与"本地排队/已提交"区分（R9）。
- [ ] 灵石计费链路未受影响（桥仍在提交前扣费；提交失败全额退回逻辑保持）（Constraints）。

## Notes

- 子任务 C 必须先做 research（定位阻塞点）再 implement，已在 C 的 prd 标注。
- RBFLow 是独立 git 仓库（`P:\RBFLow\.git`），其改动不进 lingfang-platform 的 commit；需在 RBFLow 仓库单独提交（用户后续操作）。
- 桥（Rust）改动属 lingfang-platform，需重新编译桌面端。
