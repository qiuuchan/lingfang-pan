# Implement — 子任务 D

> 仓库 `P:\RBFLow`，分支 `feat/rbflow-reliability-multiaccount`（续 A/B）。

## 步骤
1. settings.py：加 `phase_of(state, rh_account_id)`。
2. schemas.py：TaskListItem/TaskStatusResponse 加字段。
3. tasks.py：list_tasks 构造 phase 等；get_task 补 phase。
4. app/api/stats.py：GET /stats；main.py 挂载。
5. types.ts：加字段 + Account/Stats 类型。
6. api.ts：listAccounts/putAccounts/testAccountKey/getStats。
7. App.tsx + Layout.tsx：删 ProgressMonitor 路由/nav/import/PageId。
8. 删 ProgressMonitor.tsx。
9. SettingsPage.tsx：账号池管理卡。
10. TasksPage.tsx：新列 + 阶段筛选。
11. Dashboard.tsx：账号占用卡 + 阶段计数。
12. 自检：后端 import + phase_of；前端 tsc/build（若可）。
