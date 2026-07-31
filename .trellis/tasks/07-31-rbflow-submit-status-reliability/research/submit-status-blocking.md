# Research — C：提交/状态链路阻塞点定位

## 调用链（已确认）

```
插件 bridge_submit_video(timeout 30/120s)
  → 桥 POST /video/generate  (plugin_llm_bridge.rs route_video_generate)
  → relay forwardToRbflow    (apps/collab-api relay.service.ts:601 forwardToRbflowVideo)
  → RBFLow POST /api/v1/tasks        (异步 202，建库→入队→立即返回 task_id)   ← L662
       (voice 走 POST /api/v1/tasks/voice  ← L544)
```

状态查询链：
```
插件 → 桥 GET /video/stream?task_id=X  (rbflow_task_stream, 15s 超时)
     → RBFLow GET /api/v1/tasks/{id}    (立即返回当前 state/progress，非阻塞)
```

## 关键结论

1. **提交端到端是异步的**：relay 转发的是 RBFLow `POST /api/v1/tasks`（异步 202 入队即返回），**不是** `/api/v1/tasks/sync`。所以"提交阻塞到任务跑完"假设**不成立**。

2. **真正的 #2 根因：提交超时不匹配**
   - 插件 `bridge_submit_video(timeout=(30, 120))` —— 读超时 **120s**（main.py:843）。
   - relay→RBFLow 转发超时 **10min**（relay.service.ts:657/539 注释"容长任务上传"）—— 因为要把图片+视频 bytes 经 relay 上传到 RBFLow。
   - 大视频 / 慢网时，relay→RBFLow 的**上传耗时 > 120s**，**插件先超时**抛错 → 插件标记任务失败并卡住；但 relay/RBFLow 继续上传、入队、跑完。
   - 用户重进插件 → `tasks.json` 里已有 task_id（或重新查）→ 状态已是 SUCCESS。这正是"提交失败卡住、退出再进显示成功 4 个"。

3. **`/video/stream` 已非阻塞**：桥 `rbflow_task_stream` 用 15s 超时查 `GET /api/v1/tasks/{id}`，立即返回当前快照，不是 SSE 长连接。所以"状态卡住"不在 stream 端。

4. **UI 卡住的插件侧原因（待 E 验证）**：怀疑插件提交失败后 UI 状态机未正确恢复（按钮/进度卡在"提交中"），或 `ProgressWorker`/`_PollWorker` 线程异常未清理。属 E 范围。

## 改造方向（C + E 分工）

### C（relay + 桥 + 后端）
- relay 转发超时保持 10min（上传大文件需要），但**返回给桥的错误要区分"转发前/后"**：若 relay 已拿到 RBFLow task_id 再超时，不算失败（但当前是 fetch 完才返回，不会半截）。
- 桥 `/video/generate`：转发 relay 期间，超时行为对插件**不得伪报"提交失败"**；桥自身超时应 ≥ relay 超时，避免桥先于 relay 断开却让插件以为失败。
- RBFLow 提交接口保持异步 202（已满足"入队即返回"契约，无需改）。

### E（插件）
- `bridge_submit_video` **读超时上调**到与 relay 匹配（如 600s），并把"提交请求超时/失败"从"任务失败"改判为"提交未确认，任务可能已在后台运行"，**不**标 FAILED，提示用户稍后刷新。
- 提交后只要拿到 task_id 即视为已入队；拿不到（真网络错误）才可重试。
- 重进按 `tasks.json` 的 task_id 经 `/video/stream` 拉真实阶段。

## 待办
- E 阶段读插件 `_on_submit_finished` / `_on_pair_failed` / 自动刷新定时器，确认 UI 卡死的精确路径并修。
- C 阶段确认桥 `route_video_generate` 对 relay 的超时设置（读 plugin_llm_bridge.rs:1066-1160）。
