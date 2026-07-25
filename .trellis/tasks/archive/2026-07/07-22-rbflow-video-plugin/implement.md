# Implement — RBFLow 动作迁移视频生成插件（v2）

> 执行计划（ordered checklist）。需求见 `prd.md`，技术设计见 `design.md`。
> **v2 修订**：PySide6 + 美化 UI + 按秒计费(PER_SECOND) + 桥代理转发 RBFLow + 平台运营实例 + 防绕过。
> 交付物 A 必须先行（桥转发 + 计费 + contract 放行），B 的 UI 骨架可并行。

## 阶段 0：契约 + 计费单元（解锁 manifest 校验 + 按秒计费，最小先行）

- [ ] **0.1** `packages/contract/src/plugin.ts:16-21` — `CapabilityKind` enum 加 `'video.generate'`。
- [ ] **0.2** `apps/collab-api/prisma/schema.prisma:313` — `PricingUnit` enum 加 `PER_SECOND`。生成 migration `npx prisma migrate dev --name add_video_per_second`。
- [ ] **0.3** `apps/collab-api/src/modules/pricing.service.ts:76` — `computeCredits` switch 加 `case 'PER_SECOND': return pricePerUnit * Math.max(1, Math.ceil(usage.seconds ?? 0));`（usage 类型加 `seconds?: number`）。
- [ ] **0.4** 跑 contract + pricing 测试：`pnpm --filter @lingfang/contract test`、pricing 单测（PER_SECOND 计算；0.5×10秒=5，0.5×45秒=22.5 两位小数）。
- [ ] **0.5** `apps/collab-api/src/seed-credits-channels.ts` — 加视频价目行 `{ capability:'video', model:'video_generate', unit:'PER_SECOND' as const, pricePerUnit:0.5, tier:null }`（**0.5灵石/秒**，已确认；balance 是 Float 支持小数）。
- [ ] **Gate G0**：`validateManifest` 对含 `video.generate` 的 mock 通过；`computeCredits('PER_SECOND',...)` 单测绿；migration 应用成功。

## 阶段 1：relay 视频计费端点（交付物 A 核心）

- [ ] **1.1** `apps/collab-api/src/modules/relay/relay.service.ts` — 新增 `videoGenerations(req, body)`（design §2.2）：requireAuth + wireToTier + seconds clamp(≥1) + lookupPrice(capability:'video') + computeCredits(PER_SECOND,×seconds) + 建 pending LlmCallLog(capability:'video', usage.images=1) + reserve + reconcile + finalizeLog。异常路径 insufficient_balance finalize + 抛 402。
- [ ] **1.2** `apps/collab-api/src/modules/relay/relay.controller.ts:51` — 加 `@Post('videos/generations')` → `relay.videoGenerations(req, body)`。
- [ ] **1.3** 新增退款端点 `POST /videos/refund`（relay.service.ts + controller）：凭 `call_log_id` 查 LlmCallLog → refund（幂等，仅 success 可退）→ finalize status='refunded'。**用于桥转发 RBFLow 失败时退款**。
- [ ] **1.4** input schema：`{ model:'fast'|'premium', seconds:number }`；refund `{ call_log_id:string }`。
- [ ] **1.5** 单测：扣费成功 / 402 / 无定价 503 / seconds clamp / refund 幂等（重复退只退一次）。
- [ ] **Gate G1**：relay 视频端点 + refund 单测全绿；现有 chat/image relay 测试回归全绿。

## 阶段 2：桥 session + 路由骨架（交付物 A 桌面侧）

- [ ] **2.1** `plugin_llm_bridge.rs:44-46` — BridgeSession 加 `allow_video_generate: bool`。
- [ ] **2.2** `plugin_llm_bridge.rs:155-183` — `register_session` 签名加 `allow_video_generate` 参数；`:172` 「无 AI 能力」判断加 `&& !allow_video_generate`；session 构造赋值。
- [ ] **2.3** `plugin_llm_bridge.rs:221` — `register_action_session` session 构造补 `allow_video_generate: false`。
- [ ] **2.4** `plugin_llm_bridge.rs:444` — `route_request` match 加三个分支：`"/video/generate"`、`"/video/stream"`、`"/video/download"`。
- [ ] **Gate G2**：编译通过；桥测试编译通过。

## 阶段 3：桥 RBFLow 代理转发实现（交付物 A 核心 - 防绕过关键）

- [ ] **3.1** 平台 RBFLow 凭证读取：桥 `std::env::var("LINGFANG_RBFLOW_URL")`/`LINGFANG_RBFLOW_API_KEY`（桌面进程 env，**非插件 env**）；确认 `plugin_runner.rs` 给插件构造 env 时不注入这两个（防泄露）。
- [ ] **3.2** `route_video_generate(session, body)`：gate → ensure_platform_session → 解析 image/video/seconds/tier → **先 relay 计费**（`relay_post_json` POST `/api/relay/v1/videos/generations` body `{model,seconds}`）→ 402 透传 → 计费成功拿 call_log_id → **注入 RBFLow key 转发 multipart**（`build_rbflow_multipart` image+video 文件，复用 `build_image_edit_multipart` 模式；`reqwest` 600s 超时，streaming body 避大文件 OOM）→ 拿 task_id → **转发失败调 relay `/videos/refund` 退款**（凭 call_log_id）→ 返回 `{task_id, call_log_id, charged, credits}`。
- [ ] **3.3** `route_video_stream(session, query task_id)`：注入 RBFLow key → `reqwest` stream 连 RBFLow `GET /tasks/{id}/stream` → 逐块透传 `text/event-stream` 给插件（桥 SSE 代理）。
- [ ] **3.4** `route_video_download(session, query task_id)`：注入 RBFLow key → 代理 RBFLow `GET /tasks/{id}/result`（302→成品URL）→ 流式回传字节；支持 `/redownload`（POST）。
- [ ] **3.5** `build_rbflow_multipart(image, video, callback_url)`：复用 `push_file_part` 模式，两个文件 part（image + video）。
- [ ] **3.6** 桥测试（`tests.rs`）：`insert_test_session` 签名加 allow_video；gate 403；计费 402 不转发（mock relay）；计费成功转发（mock RBFLow）；RBFLow 失败触发 refund（mock）；断言**插件 env 无 LINGFANG_RBFLOW_***。
- [ ] **Gate G3（A 完成）**：`cargo test` 全绿；端到端 mock：声明 video.generate 的插件调桥 → 计费 → 转发 mock RBFLow → 返回 task_id。

## 阶段 4：桥调用方白名单 + SDK 路由表（交付物 A 收尾）

- [ ] **4.1** `plugin_runner.rs:1552-1560` — 加 `manifest.capabilities.iter().any(|k| k=="video.generate")` → `allow_video_generate`。
- [ ] **4.2** `plugin_script.rs:581-589` — 同上。
- [ ] **4.3** `packages/plugin-sdk/src/index.ts:222` — SCRIPT_BRIDGE_PATH 加 `'video.generate':'/video/generate'`。
- [ ] **4.4** SDK invokeAi capability 类型联合（`:298` 附近）补 `'video.generate'`；`pnpm --filter @lingfang/plugin-sdk test`。

## 阶段 5：RBFLow 插件骨架（交付物 B - 桥层 + 时长探测）

- [ ] **5.1** 建目录 `plugins/rbflow-video/`：`manifest.json`（design §3.2）、`requirements.txt`（`PySide6>=6.7`、`requests`、`Pillow`、`ffmpeg-python`）、`README.md`。
- [ ] **5.2** `main.py` 桥层：`_BRIDGE_URL`/`_TOKEN` 读 env（无 fallback）；`bridge_submit_video(image_path, video_path, seconds, tier)` 调 `/video/generate`（multipart）；`bridge_stream(task_id)` 调 `/video/stream`（SSE）；`bridge_download(task_id, dest)`。
- [ ] **5.3** `main.py` 时长探测：`probe_duration(video_path)` → `ffmpeg-python`/`ffprobe` subprocess 读 duration 秒。
- [ ] **5.4** `main.py` Task 模型 + TaskStore（JSON 持久化）：Task（pair_id, image_path, video_path, seconds, task_id, state, progress, call_log_id, saved_path, order, timestamps）。
- [ ] **Gate G4**：`python main.py` 在有桥 env 环境跑起不崩（无 env 友好提示）；时长探测对一个 mp4 返回正确秒数。

## 阶段 6：PySide6 三栏 UI + 美化（交付物 B - 界面）

- [ ] **6.1** `theme.qss` — Catppuccin Mocha 暗色系：背景/卡片/强调/状态色；圆角 8px、按钮 hover/press、QListWidget 圆角项、QProgressBar 自绘。
- [ ] **6.2** 自定义控件：`CardWidget`（圆角+阴影）、`StatusBadge`（色标圆点）、`RoundButton`。
- [ ] **6.3** 左栏 `ImagePanel`：分类下拉（新建/刷新）+ 选图/选文件夹圆角按钮 + QListWidget(IconMode 圆角缩略图多选) + 工具行(全选/反选/未选/删除/移动分类)。
- [ ] **6.4** 中栏 `VideoPanel`：分类下拉 + 上传视频/选文件夹 + QListWidget(多选) + 「工作流节点」配置卡(4×QLineEdit 默认 78/image/77/video)。
- [ ] **6.5** 右栏 `QueuePanel`：统计卡(总计/等待/执行中/错误/完成) + 状态 QTabWidget + 输出目录(LineEdit+浏览+记忆) + 任务 QListWidget(CardWidget 项：缩略图+进度环+状态色标+时长+灵石+时间戳+操作图标) + 底部批量操作 + 自动重试/刷新开关。
- [ ] **6.6** `MainWindow`：QHBoxLayout(3:4:3) + 顶栏 banner(Logo+标题+档位切换+计费徽章)；加载 theme.qss。
- [ ] **6.7** 队列排序：DragDropMode.InternalMove + 右键(上移/下移/置顶)；TaskStore 持久化 order。
- [ ] **Gate G5**：对照截图三栏 + 深色美化窗口可显示；各栏控件可交互（mock 数据）；队列可拖拽排序持久化。

## 阶段 7：提交/计费/进度/落盘 端到端（交付物 B - 业务流）

- [ ] **7.1** `SubmitWorker`：选图×视频笛卡尔积 → 每 video probe_duration → 汇总弹「预计 N 任务 / 总 S 秒 / 消耗 S×单价 灵石」确认 → 逐 pair `bridge_submit_video(image,video,seconds,tier)`（处理 402 拦截停止）→ 建 Task 入队 → 启 ProgressWorker。
- [ ] **7.2** `ProgressWorker`：每 task 一线程 `bridge_stream(task_id)`（桥代理 SSE）→ progress/done/error 信号推 UI 更新卡片（进度环/状态色标）；断连退避重连(≤5)→ 超限转桥轮询。
- [ ] **7.3** `DownloadWorker`：done → `bridge_download(task_id)` → 按模板 `{输出目录}\{日期}\{图片分类}\{图片名}_{视频名}.mp4` 落盘 → 记 saved_path；卡片「另存为」(QFileDialog)、「重新下载」(桥 /redownload)。
- [ ] **7.4** 卡片操作：强制重新执行/编辑/删除；批量删除、清除已完成。
- [ ] **7.5** 容错：FAILED-but-ready → 重新下载；421 → 自动重试开关延迟重提。
- [ ] **Gate G6（B 完成）**：端到端 QA（对照 prd 验收清单 B）：选图×视频 → 按秒扣灵石 → 桥转发 RBFLow → 进度实时 → 落盘自定义文件夹 → 重启恢复。

## 阶段 8：质量门 + 收尾

- [ ] **8.1** 全量 lint/typecheck/test：contract + plugin-sdk + collab-api + desktop Rust（`cargo test` + clippy）。
- [ ] **8.2** 回归：现有 chat/image relay、现有 PySide6 插件（videodl/facefusion）manifest 校验不受影响。
- [ ] **8.3** **防绕过审计**：确认插件进程 env 无 `LINGFANG_RBFLOW_*`；插件代码无任何 RBFLow URL/key 硬编码或读取。
- [ ] **8.4** 打包插件 `.lfplugin`（若有脚本）；更新 CHANGELOG / 插件 README。
- [ ] **8.5** `trellis-check` 全量 + spec 更新（Phase 3.3）。

## 验证命令

```bash
pnpm --filter @lingfang/contract test
pnpm --filter @lingfang/plugin-sdk test
pnpm --filter @lingfang/collab-api test
cd apps/desktop/src-tauri && cargo test
npx prisma migrate dev --name add_video_per_second   # 阶段0
cd plugins/rbflow-video && python main.py             # 冒烟（有桥 env）
```

## 回滚点

- 阶段 0-4（平台 A）：纯加法（新 enum/新 flag/新路由/新方法/新 unit），revert commit 即回滚；Prisma migration 需 `migrate rollback`。
- 阶段 5-7（插件 B）：全新目录 `plugins/rbflow-video/`，删目录即回滚。

## 依赖与并行

- 阶段 0→1→2→3→4 串行（A 内部强依赖）。
- 阶段 5-6（插件骨架/UI）可与阶段 1-4 并行（A 未就绪时桥层 mock）。
- 阶段 7 必须在 Gate G3（A 完成）后。
