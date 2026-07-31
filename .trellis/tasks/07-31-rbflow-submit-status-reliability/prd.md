# 提交/状态链路可靠性（桥+后端+插件）（子任务 C）

> 父任务：`07-31-rbflow-reliability-multiaccount`。共享架构见父 `design.md` 第 5 节。
> **本任务必须先做 research 再 implement。** 跨三个代码库。

## Goal

根治"提交一个任务显示提交失败就卡住、但后端还在生成；退出重进显示成功"的同步/阻塞问题。建立"**提交即入本地队列快速返回 task_id**"契约，插件与后端状态靠定时拉取同步，提交层超时不再等于任务失败。

## 涉及代码库

- `P:\lingfang-platform\apps\desktop`（Rust 桥 `plugin_llm_bridge.rs` 等）
- `P:\RBFLow\app\api\tasks.py`（提交/状态接口）
- `P:\lingfang-platform\plugins\rbflow-video\main.py`（`bridge_*` 客户端；与 E 协同，C 侧重链路契约与桥/后端，E 侧重插件 UI/轮询）

## Requirements

### Research 阶段（research/ 目录产出，先于 implement）
- R5.R1 定位当前提交链路的精确阻塞点：读桥 `/video/generate` 实现（是否同步等 RBFLow 直到 RB create 完成？是否含 421 重试阻塞？）+ RBFLow `app/api/tasks.py` 提交接口（是否同步跑 `orchestrator.run_task` / 同步 create？还是入队即返回？）。
- R5.R2 定位 `/video/stream`（桥）→ RBFLow 状态接口的阻塞/超时行为，确认插件"卡住"根因（怀疑桥 stream 聚合 SSE 长阻塞或 RBFLow 接口同步等终态）。
- R5.R3 产出"现状时序图 + 阻塞点标注 + 改造方案"写入 `research/`。

### Implement 阶段
- R5.I1 RBFLow 提交接口：**写库(state=PENDING) → 入本地队列 → 立即返回 task_id**，绝不阻塞到 RB create/上传。若现状是同步阻塞，改为入队即返回。
- R5.I2 桥 `/video/generate`：扣灵石 → 转发该快速接口，转发不阻塞；扣费失败/提交失败按现策略退款。
- R5.I3 状态拉取：桥提供轻量状态接口（复用 `/video/stream` 改短超时一次性返回当前快照，或新增 `/video/status`），**不**长阻塞等终态。
- R5.I4 插件 `bridge_*`（与 E 协同）：提交返回 task_id 即视为已入队；状态改定时拉取（5 分钟）；提交层超时显示"提交超时，任务可能已在后台运行，请刷新"，**不**标记任务失败。
- R5.I5 插件重进能按本地 `tasks.json` 里的 task_id 重新拉真实阶段，不丢任务。

## Acceptance Criteria

- [ ] `research/submit-status-blocking.md`（或同名）产出，含现状时序图与阻塞点标注。
- [ ] RBFLow 提交接口 P95 响应 < 2s（入队即返回），不随 RB create 时长增长。
- [ ] 模拟桥/插件侧提交请求超时（手动断连）：后端任务仍继续跑到 SUCCESS；插件重进看到真实状态，UI 不卡。
- [ ] 状态拉取接口不长阻塞；插件定时刷新期间 UI 响应正常。
- [ ] 灵石扣费/退款逻辑未变（提交失败仍全额退；入队成功才扣）。

## Dependencies / Notes

- 依赖 A 的状态模型（phase、rh_account_id）。
- 与 E 强相关：C 定链路契约 + 桥/后端，E 落插件 UI/轮询。两者建议同分支或紧邻迭代。
- 桥（Rust）改完需重编桌面端；RBFLow 改动在独立仓库提交。
