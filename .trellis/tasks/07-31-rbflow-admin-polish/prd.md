# RBFLow 管理后台打磨：页面切换动画+设置可写+任务详情悬浮窗+10分页+1分钟刷新

## Goal
RBFLow 管理前端 5 项打磨：页面切换动画、运行参数可写（不再只改 config.yaml）、任务详情改悬浮窗、默认 10 分页、任务详情/列表获取间隔改 1 分钟。

## Requirements
- R1 页面切换动画：dashboard/submit/tasks/settings 切换时有淡入/滑动过渡（非瞬切）。
- R2 设置可写：`PUT /api/v1/config` 更新 runtime 参数（run_poll/eta_baseline/failure_grace/poll_interval/http_*/421 等），持久化到 `data/runtime_overrides.json`，启动时回放；运行时直接 mutate `runtime` 单例属性即时生效。前端设置页改可编辑输入 + 保存。
- R3 任务详情悬浮窗：用 shadcn Dialog 替代 TasksPage 行内展开；点击行/展开按钮打开悬浮窗，内含原 TaskDetailPanel 内容。
- R4 默认 10 分页：TasksPage `pageSize` 默认 10（原 20）。
- R5 获取间隔 1 分钟：TasksPage 列表 auto-refresh 5s→60s；TaskDetailPanel 改 60s 轮询 getTask+getTaskLogs（弃用 SSE 长连接，简化悬浮窗生命周期）。

## Acceptance Criteria
- [ ] 切换页面有可见淡入/滑动动画（key=page 触发）。
- [ ] 设置页改 run_poll_interval_sec 等参数 → 保存 → 后端实际生效（`runtime.run_poll_interval_sec` 变化）；重启后保留。
- [ ] 任务详情以悬浮窗（Dialog）打开，关闭即销毁，无行内展开。
- [ ] TasksPage 默认每页 10。
- [ ] TasksPage 列表刷新间隔 ≈60s；TaskDetailPanel 轮询间隔 ≈60s，无 SSE 连接残留。

## Notes
- 仓库 `P:\RBFLow`，分支 `feat/rbflow-reliability-multiaccount`（续）或直接 main——上轮已合并 main，本任务在 main 上提交。
- runtime 是 lru_cache 单例（pydantic BaseModel，属性可变），mutate 即时生效；orchestrator 读 `runtime.*` 实时反映。
