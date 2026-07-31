# Design — 子任务 C：提交/状态链路可靠性（结论）

> 研究见 `research/submit-status-blocking.md`。

## 结论：后端 / 桥 / relay **无需代码改动**

整条提交链路已异步、超时已对齐：

| 段 | 超时 | 行为 |
|----|------|------|
| 插件 `bridge_submit_video` → 桥 | **读超时 120s** ← 唯一过短 | 大视频上传 >120s 时插件先超时 |
| 桥 → relay `/api/relay/v1/videos/generations` | 600s（plugin_llm_bridge.rs:1157） | 转发素材 |
| relay → RBFLow `POST /api/v1/tasks` | 600s（relay.service.ts:657） | **异步 202，拿 task_id 即返回**，不等任务跑完 |
| 桥 `/video/stream` → RBFLow `GET /api/v1/tasks/{id}` | 15s | 即时短轮询，非阻塞 |

RBFLow `/api/v1/tasks`、`/api/v1/tasks/voice` 本就是"建库→入队→立即 202 返回 task_id"（tasks.py:85-107、164-196），满足"提交即入队"契约。relay `forwardToRbflow` / `forwardToRbflowVoice` 透传 task_id 即返回。

## 根因（单一）
插件 `bridge_submit_video(timeout=(30, 120))` 读超时 120s。大视频经 relay 上传到 RBFLow 的耗时可能 >120s → **插件先超时抛错 → 标记任务失败 + UI 卡**；但 relay/RBFLow 继续上传、入队、跑完。重进插件时，已拿到 task_id 的任务经 `/video/stream` 查到 SUCCESS → "显示成功了 4 个"。

## 修复（全部落在 E，本任务无独立 diff）
1. 插件 `bridge_submit_video` 读超时上调到 **600s**（与桥/relay 对齐）。
2. 插件提交**超时/网络错误**改判为"提交未确认，任务可能已在后台运行"，**不**标 `FAILED`，提示用户稍后刷新；仅在确无 task_id 且确认是计费/参数错误时才失败。
3. 拿到 task_id 即视为"已入队"，后续一律走定时状态拉取。

## 交付物
- `research/submit-status-blocking.md`（已完成，含调用链时序 + 根因 + 改造方向）。
- 本 design.md（结论：无后端改动，修复在 E）。

C 的验收（"插件提交超时后端仍跑、重进看到真实状态、UI 不卡"）由 E 的实现兑现。
