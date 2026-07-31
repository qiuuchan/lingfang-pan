# 管理后台：独立配置页+阶段化任务管理+仪表盘增强（子任务 D）

> 父任务：`07-31-rbflow-reliability-multiaccount`。共享架构见父 `design.md` 第 4、6 节。
> 仓库：`P:\RBFLow\frontend`（React）+ 后端配置/统计 API。

## Goal

RBFLow 管理前端新增**独立配置页**（轮询间隔、多账号池、超时/重试等），任务管理改成**按阶段（排队/上传/运行/完成/失败）呈现**并显示更详细字段，仪表盘增补吞吐/并发/耗时统计。删除旧的实时进度页。

## Scope（改动文件）

- `frontend/src/components/pages/SettingsPage.tsx`：扩为完整配置页（轮询间隔、账号池 CRUD + key 校验、failure_grace、421 退避、http 超时/重试）。
- `frontend/src/components/pages/TasksPage.tsx`：按阶段分组/筛选；列加 `rh_task_id`、`rh_account_id`、`phase`、`duration`、`retry_count`、`error_code`。
- `frontend/src/components/pages/Dashboard.tsx`：总任务/各阶段/成功率/平均耗时/各账号并发占用与吞吐。
- 删除 `frontend/src/components/pages/ProgressMonitor.tsx` + `App.tsx` 路由/导航入口。
- `frontend/src/lib/types.ts` + `api.ts`：新字段与新接口对接。
- 后端：账号池读写 API（B 定义，D 消费）、`/tasks` 序列化补 `phase` 等字段（A/B 提供）、统计聚合 API（D 新增）。

## Requirements

- R7.1 独立配置页，分区分组：轮询（`run_poll_interval_sec` 等）、账号池（每行：id/key(脱显)/并发上限/启用/校验按钮）、容错（`failure_grace_sec`、421 退避、http 超时/重试）。保存 → 后端持久化 + 热生效。
- R7.2 账号 key 校验按钮：调后端 → RB ping，回显有效/无效。
- R6.1 任务管理按 `phase` 分组或筛选 tab（排队/上传/运行/完成/失败），明确区分"本地排队"（`PENDING + rh_account_id=NULL`）与"已提交"。
- R8.1 任务管理列：`rh_task_id`、`rh_account_id`、`phase`、耗时、重试次数、错误码。
- R8.2 仪表盘：总数、各阶段计数、成功率、平均耗时、各账号并发占用/吞吐（数据来自 B 的账号池快照 + 任务表聚合）。
- R2.D 删除 ProgressMonitor 页 + 路由 + 导航。

## Acceptance Criteria

- [ ] 配置页改 `run_poll_interval_sec` → 保存 → 后端实际轮询间隔变化（日志验证）。
- [ ] 配置页增删 RB 账号、改并发上限 → 账号池热更新生效（与 B 的快照 API 对账）。
- [ ] 账号 key 校验按钮：有效 key 显示 ✓，无效显示 ✗ 与原因。
- [ ] 任务管理能看到 5 个阶段分组，且"本地排队"任务明确标注（无 rh_account_id）。
- [ ] 任务管理列含 rh_task_id、所属账号、阶段、耗时、重试、错误码。
- [ ] 仪表盘展示各阶段计数 + 各账号并发占用。
- [ ] ProgressMonitor 页与导航入口已移除，构建无残留引用。

## Dependencies / Notes

- 依赖 A（phase 字段、`run_poll_interval_sec`）、B（账号池 API、`rh_account_id`）。
- 统计是实时聚合（查询时算）还是定时快照 → 写在本任务 `design.md`。
- 前端组件遵循现有 shadcn/ui 风格（见 `frontend/src/components/ui/*`）。
