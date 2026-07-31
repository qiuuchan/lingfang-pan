# Design — 子任务 D：管理后台配置页+阶段化任务管理+仪表盘增强

> 遵守父 `design.md` 第 4、6 节。消费 A（phase/run_poll）+ B（账号池 API）。

## 后端
- `settings.py` 加 `phase_of(state, rh_account_id) -> str`：queued/uploading/running/done/failed。
- `schemas.py`：`TaskListItem` 加 `rh_task_id/rh_account_id/phase/retry_count/error_code`；`TaskStatusResponse` 加 `rh_account_id/phase/retry_count/error_code`。
- `tasks.py list_tasks`：构造新字段（phase 经 `phase_of`）。`get_task` 用 `to_dict`（已含 rh_account_id）+ 补 phase。
- 新 `app/api/stats.py`：`GET /api/v1/stats` → 各 phase 计数 + 各账号并发占用（取 `manager.pool.snapshot()` + 任务表聚合）。挂到 main。

## 前端
- 删 `ProgressMonitor.tsx` + App.tsx 路由/import + Layout NAV `progress` + PageId。
- `types.ts`：TaskListItem 加字段；加 `Account/AccountPoolSnapshot/Stats` 类型。
- `api.ts`：`listAccounts/putAccounts/testAccountKey/getStats`。
- `SettingsPage.tsx`：新增「RB 账号池」卡（列表：id/并发/启用/占用，增删改 + key 校验按钮 + 保存）+ 轮询间隔展示（来自 stats/health）。
- `TasksPage.tsx`：列加 阶段/RB任务ID/账号/重试/错误码；状态筛选补阶段语义。
- `Dashboard.tsx`：加「账号池占用」卡（每账号 in_flight/limit）+ 各阶段计数卡。

## 验证
- 后端 import + `GET /api/v1/stats` shape + `phase_of` 单测。
- 前端 tsc 编译（若可跑 `npm run build`）；否则人工审查类型。
