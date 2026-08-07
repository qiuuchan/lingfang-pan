# Design — RBFLow 动作迁移视频生成插件（平台运营 + 按秒计费 + 防绕过）

> 复杂任务技术设计。实现执行计划见 `implement.md`。需求见 `prd.md`。
> **v2 修订**（用户反馈）：① PySide6(Qt6) ② 美化 UI ③ 按秒计费(PER_SECOND) ④ 桥代理转发 RBFLow + 平台运营实例 + 防绕过。初版「连接外部实例/桥纯扣费不转发」已废弃。

## 1. 边界与核心决策

### 1.1 两个交付物的依赖关系

```
交付物 A（平台视频计费 + 桥代理转发） ──契约先行──▶ 交付物 B（PySide6 插件）
   contract/桥/relay/seed/PER_SECOND               插件只调桥，不直连 RBFLow
```

A 是 B 的前提。B 的 UI 骨架可与 A 并行（A 未就绪时桥层 mock）。

### 1.2 关键决策（v2 已定）

| 决策点          | 选择                                            | 理由                                                                                       |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Qt 框架         | **PySide6 (Qt6)**                               | 与 `videodl`/`facefusion` 一致；`plugin_runner.rs:13` 已为 PySide6 深层 wheel 做短路径缓存 |
| UI 风格         | **现代深色 QSS + 自定义控件**                   | 用户要求美化；对照截图暗色三栏                                                             |
| 计费方式        | **按秒 PER_SECOND（新增单元）**                 | 用户要求；按视频时长计费比按条更公平                                                       |
| RBFLow 凭证位置 | **平台侧配置（用户不可见）**                    | 防绕过的根本对策                                                                           |
| 桥形态          | **代理转发 RBFLow**（先扣费→转发→返回 task_id） | 桥持有平台 RBFLow 凭证，插件无凭证→物理无法绕过                                            |
| RBFLow 归属     | **平台统一运营单实例**                          | 凭证天然放平台侧；用户无需知道 RBFLow 存在                                                 |
| relay 端点形态  | **精简计费编排，不接渠道路由**                  | 视频上游是 RBFLow（桥转发），relay 只做灵石账本                                            |

### 1.3 防绕过数据流（核心安全保证）

```
插件进程 env: { LINGFANG_PLUGIN_BRIDGE_URL, LINGFANG_PLUGIN_BRIDGE_TOKEN }  ← 仅这两个，无 RBFLow 凭证
   │
   ▼  POST /video/generate  (image+video multipart + seconds + tier)
桥 plugin_llm_bridge.rs
   │  1. gate allow_video_generate
   │  2. ensure_platform_session（Bearer → relay）
   │  3. relay /api/relay/v1/videos/generations 按秒计费（reserve→reconcile）
   │  4. 【计费成功后】注入平台侧 RBFLow_URL + RBFLow_API_KEY → 转发 multipart 到 RBFLow POST /api/v1/tasks
   │  5. 返回 {task_id, call_log_id, charged, credits}
   ▼
平台运营 RBFLow 实例（用户不可见的地址）

进度：插件 → 桥 /video/stream?task_id → 桥代理 RBFLow SSE /tasks/{id}/stream → 透传
下载：插件 → 桥 /video/download?task_id → 桥代理 RBFLow /tasks/{id}/result → 流式回传
```

**安全保证**：插件进程无 RBFLow 凭证 + 不知 RBFLow 地址 → 任何绕过桥的直连尝试都无法构造合法 RBFLow 请求。计费与转发**原子绑定在桥内**（先扣后转；扣费失败不转发）。

### 1.4 按秒计费机制

- **时长探测**：插件用 `ffprobe`（`moviepy`/`ffmpeg-python` 备选）读取参考视频 duration（秒，向上取整或保留 1 位小数）。
- **计费**：relay `videoGenerations` 收到 `seconds` → `PER_SECOND` 单价 × seconds（秒）→ reserve(总额) → reconcile(实额)。单价 0.5 灵石/秒；`TeamCredit.balance` 是 Float + `roundCredits` 两位小数，0.5×秒 自洽。
- **预扣**：笛卡尔积 N×M 任务，插件一次性把「所有 video 的总秒数」传给桥预扣？**否**——逐任务提交更安全（单任务失败不影响其他，且 RBFLow 串行队列天然逐个）。改为：**每提交一对（image+video），单独调一次 `/video/generate`**，传该 video 的 seconds。
- **秒数信任（MVP）**：信任插件 ffprobe 上报 + relay clamp(≥1) + 后台审计异常值（不改桥侧，不要求桌面带 ffprobe）。

## 2. 交付物 A 架构：平台视频计费 + 桥代理转发

### 2.1 改动清单

| 层                   | 文件                                                                                           | 改动                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 契约                 | `packages/contract/src/plugin.ts:16`                                                           | `CapabilityKind` enum 加 `'video.generate'`                                                                             |
| **计费契约**         | `apps/collab-api/prisma/schema.prisma:313`                                                     | `PricingUnit` enum 加 `PER_SECOND`                                                                                      |
| **计费实现**         | `apps/collab-api/src/modules/pricing.service.ts:76`                                            | `computeCredits` switch 加 `case 'PER_SECOND': return pricePerUnit * Math.max(0, usage.seconds ?? 0)`（向上取整秒）     |
| 桥 session           | `apps/desktop/src-tauri/src/plugin_llm_bridge.rs:44`                                           | BridgeSession 加 `allow_video_generate: bool`                                                                           |
| 桥路由               | `plugin_llm_bridge.rs:444`                                                                     | match 加 `"/video/generate"` + `"/video/stream"` + `"/video/download"`                                                  |
| 桥转发实现           | `plugin_llm_bridge.rs` 新增 `route_video_generate`/`route_video_stream`/`route_video_download` | gate + 计费(经relay) + **注入平台 RBFLow 凭证转发**（复用 `build_*_multipart` + `relay_post_raw` 模式）                 |
| 桥调用方             | `plugin_runner.rs:1552` + `plugin_script.rs:581`                                               | 各加 `\|\| k=="video.generate"` → `allow_video_generate`                                                                |
| relay 控制器         | `apps/collab-api/src/modules/relay/relay.controller.ts:51`                                     | 加 `@Post('videos/generations')`                                                                                        |
| relay 服务           | `apps/collab-api/src/modules/relay/relay.service.ts`                                           | 新增 `videoGenerations`（精简计费编排，收 seconds，PER_SECOND）                                                         |
| 价目 seed            | `apps/collab-api/src/seed-credits-channels.ts`                                                 | 加 `{ capability:'video', model:'video_generate', unit:'PER_SECOND', pricePerUnit:1, tier:null }`（1灵石/秒占位，可改） |
| **平台 RBFLow 配置** | 桥读 env/配置（`LINGFANG_RBFLOW_URL`/`LINGFANG_RBFLOW_API_KEY`）或 collab-api PlatformSetting  | RBFLow 凭证平台侧注入，不入插件 env                                                                                     |
| SDK 路由表           | `packages/plugin-sdk/src/index.ts:222`                                                         | SCRIPT_BRIDGE_PATH 加 `'video.generate':'/video/generate'`                                                              |

**不动**：`capability.rs`（AI 能力不经 invoke 网关）、现有 `executeRelay` 链路、现有 chat/image 扣费。

### 2.2 relay `videoGenerations` 精简计费编排（PER_SECOND）

```ts
// relay.service.ts 新增方法（伪码，引用真实 API）
async videoGenerations(req: Request, body: VideoRelayInput) {
  const auth = this.requireAuth(req);                 // relay.service.ts:300
  const tier = wireToTier(body.model ?? 'fast');
  const seconds = Math.max(1, Math.ceil(Number(body.seconds) || 0)); // 至少1秒，防0秒白嫖

  const price = await this.pricing.lookupPrice({ capability: 'video', model: 'video_generate', tier });
  if (!price) throw new AppError(503, 'no_pricing', '视频生成未配置定价');

  // PER_SECOND：computeCredits 返回 pricePerUnit × seconds
  const totalCredits = this.pricing.computeCredits(price.unit, price.pricePerUnit, { seconds });

  const pendingLog = await this.prisma.llmCallLog.create({ data: {
    teamId: auth.teamId, userId: auth.userId, capability: 'video', tier,
    model: 'video_generate', status: 'reserve', requestId, clientIp,
    requestSummary: { seconds, tier } as never,
    clientSource: clientSourceFromRequest(req), credits: 0,
  }});

  try {
    await this.credits.reserve(auth.teamId, totalCredits, pendingLog.id, auth.userId);
  } catch (e) { // 402
    await this.finalizeLog(pendingLog.id, { status:'insufficient_balance', errorCode:'insufficient_balance', httpStatus:402, channelId:null, model:'video_generate', durationMs:Date.now()-startedAt, usage:{inputTokens:0,outputTokens:0,images:0}, credits:0 });
    throw e;
  }
  const charged = await this.credits.reconcile(auth.teamId, totalCredits, totalCredits, pendingLog.id, auth.userId);
  await this.finalizeLog(pendingLog.id, { status:'success', errorCode:null, httpStatus:200, channelId:null, model:'video_generate', durationMs:Date.now()-startedAt, usage:{inputTokens:0,outputTokens:0,images:1}, credits:charged });
  return { charged: true, credits: charged, call_log_id: pendingLog.id, request_id: requestId };
}
```

> **关键**：relay 只扣费，**不转发 RBFLow**（relay 在 collab-api，不该知道 RBFLow 地址）。RBFLow 转发在**桌面桥**层（`plugin_llm_bridge.rs`），桥读平台配置的 RBFLow 凭证。这样 relay 保持「纯计费账本」通用性，RBFLow 耦合只发生在桥。

### 2.3 桥 `route_video_generate`（计费 + 转发 RBFLow）

```rust
// plugin_llm_bridge.rs 新增（伪码）
fn route_video_generate(session: &BridgeSession, body: RequestBody) -> BridgeResult<Value> {
    if !session.allow_video_generate { return Err(403 capability_denied); }
    ensure_platform_session(session)?;

    // 1. 解析 image/video/seconds/tier（multipart 或 base64 JSON）
    let seconds = body.seconds;
    let tier = body.tier;

    // 2. 先经 relay 按秒计费（透传 bearer）
    let charge = relay_post_json(session, "/api/relay/v1/videos/generations",
        json!({ "model": tier, "seconds": seconds }))?;
    if charge.status != 200 { return charge; } // 402 insufficient_balance 透传给插件
    let call_log_id = charge["call_log_id"];

    // 3. 计费成功 → 注入平台 RBFLow 凭证转发
    let rbflow_url = std::env::var("LINGFANG_RBFLOW_URL")?;       // 平台侧配置，非插件 env
    let rbflow_key = std::env::var("LINGFANG_RBFLOW_API_KEY")?;
    let multipart = build_rbflow_multipart(image_bytes, video_bytes, callback_url);
    let rbflow_resp = reqwest::Client::new().post(format!("{}/api/v1/tasks", rbflow_url))
        .header("X-API-Key", rbflow_key)
        .header("Content-Type", multipart_content_type)
        .body(multipart)
        .timeout(Duration::from_secs(600))
        .send()?;
    let task_id = rbflow_resp.json()["task_id"];

    // 4. 返回 task_id + 扣费票据
    Ok(json!({ "task_id": task_id, "call_log_id": call_log_id, "charged": true, "credits": charge["credits"] }))
}
```

> **原子性边界**：计费成功但 RBFLow 转发失败（如 RBFLow 宕机）→ 灵石已扣但任务没建。MVP 处理：桥捕获转发失败 → 调 relay 退款（凭 call_log_id；需新增 `POST /videos/refund`，或 MVP 先记 warn 日志不退，文档明示）。**优先做退款端点**，否则有扣费无服务的审计风险。

### 2.4 桥 `/video/stream`（SSE 代理）+ `/video/download`

- `/video/stream?task_id=X`：桥用 `reqwest` stream 连 RBFLow `GET /api/v1/tasks/{id}/stream`（注入 RBFLow key），逐块透传给插件（`text/event-stream`）。插件用 `requests` stream 解析 SSE——**插件始终不直连 RBFLow**。
- `/video/download?task_id=X`：桥代理 RBFLow **`GET /tasks/{id}/download`**（v0.4 流式 mp4 blob，`tasks.py:311`，替代旧 `/result` 302 重定向）→ 流式回传字节给插件落盘。流式避免大文件 OOM。

### 2.5 平台 RBFLow 凭证配置

三种可选（MVP 取最简）：

- **A（推荐 MVP）**：桌面进程 env `LINGFANG_RBFLOW_URL`/`LINGFANG_RBFLOW_API_KEY`，由软件启动时从平台配置/`.env` 注入桌面进程（非插件进程）。桥读 `std::env::var`。
- B：collab-api PlatformSetting 表存 RBFLow 配置，桥调 collab-api 取。多一跳。
- C：管理端 UI 配置 RBFLow 凭证。

> 选 A：最小改动，凭证只在桌面进程内存，插件进程 env 不含（`plugin_runner.rs` 给插件构造 env 时**不注入**这两个变量）。

## 3. 交付物 B 架构：PySide6 插件（美化 UI）

### 3.1 插件结构

```
plugins/rbflow-video/
├── manifest.json          # runtime_type=python, capabilities=[video.generate]
├── main.py                # PySide6 入口 + 三栏窗口 + QSS
├── requirements.txt       # PySide6>=6.7, requests, Pillow, ffmpeg-python
├── theme.qss              # 现代深色主题样式表
└── data/                  # app.log, tasks.json, thumbnails/
```

### 3.2 manifest.json

```jsonc
{
  "id": "com.lingfang.rbflow-video",
  "name": "动作迁移视频生成",
  "version": "0.1.0",
  "description": "RunningHub 动作迁移工作流：上传参考图片+视频→按视频时长（秒）扣灵石→生成视频→实时进度→保存到自定义文件夹。支持任务队列排序、多素材笛卡尔积。视频生成经平台桥代理，按团队灵石按秒计费，无需配置任何密钥。",
  "runtime_type": "python",
  "entry": "main.py",
  "visibility": "tenant",
  "capabilities": [
    {
      "kind": "video.generate",
      "reason": "经平台视频能力按秒扣灵石生成视频",
      "risk": "medium",
      "requires_admin": false,
    },
  ],
}
```

> **注意**：manifest **不声明任何 RBFLow 字段**；插件**无 RBFLow 配置项**。符合 C1 强化约束。

### 3.3 main.py 模块划分

| 模块                | 职责                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **桥层**            | `_BRIDGE_URL`/`_TOKEN` 读 env（无 fallback）；`bridge_submit_video(image,video,seconds,tier)` 调 `/video/generate`；`bridge_stream(task_id)` 调 `/video/stream`；`bridge_download(task_id,dest)` 调 `/video/download` |
| **时长探测**        | `probe_duration(video_path)` → 用 `ffmpeg-python`/`ffprobe` subprocess 读 duration（秒）                                                                                                                              |
| **三栏 UI**         | `ImagePanel`(左)、`VideoPanel`(中)、`QueuePanel`(右)，`MainWindow` 组装                                                                                                                                               |
| **任务模型+持久化** | `Task` dataclass + `TaskStore`(JSON)                                                                                                                                                                                  |
| **工作线程**        | `SubmitWorker`(笛卡尔积+探测时长+逐个扣费提交)、`ProgressWorker`(桥SSE)、`DownloadWorker`(下载落盘)                                                                                                                   |
| **主题**            | `theme.qss` 加载 + 自定义控件（CardWidget/ProgressBar/RoundButton/StatusBadge）                                                                                                                                       |

### 3.4 三栏 UI + 美化（对照截图）

| 栏                | 控件                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **顶栏**          | 深色 banner：Logo + 标题 + 计费档位(fast/premium 切换) + 「🔌 按秒·灵石计费」状态徽章                                                                                                                |
| **左栏 图片输入** | 圆角分组：「📁 图片素材」标题 + 分类下拉(新建/刷新) + 「选择图片」「选文件夹」圆角按钮 + QListWidget(IconMode 圆角缩略图多选) + 工具行(全选/反选/未选/删除/移动)                                     |
| **中栏 参考视频** | 圆角分组：「🎬 参考视频」+ 分类下拉 + 「上传视频」「选文件夹」 + QListWidget(多选) + 「⚙ 工作流节点」配置卡(4×QLineEdit 默认 78/image/77/video)                                                      |
| **右栏 任务队列** | 统计卡(总计/等待/执行中/错误/完成，带图标) + 状态 QTabWidget + 输出目录(LineEdit+浏览) + 任务 QListWidget(每项=CardWidget：缩略图行+进度环+状态色标+时长+灵石+时间戳+操作图标) + 底部批量操作 + 开关 |

**美化要点（QSS）**：

- 配色：背景 `#1e1e2e`/`#181825`，卡片 `#313244`，强调 `#89b4fa`（蓝），成功 `#a6e3a1`，警告 `#f9e2af`，错误 `#f38ba8`（Catppuccin Mocha 暗色系，与截图暗色风一致）
- 控件：圆角 8px、卡片阴影 `QGraphicsDropShadowEffect`、按钮 hover/press 态、进度用 `QProgressBar` 自绘圆角 + 百分比文字、状态色标圆点
- 字体：系统默认 + 适当字重

**队列排序**：QListWidget `DragDropMode.InternalMove` + 右键菜单；TaskStore 持久化 order。

**自定义文件夹**：命名模板 `{输出目录}\{日期}\{图片分类}\{图片名}_{视频名}.mp4`。

### 3.5 提交/计费/下载流程

```
用户点「提交」
  → 笛卡尔积 pairs = images × videos
  → 对每 video：probe_duration → 得 seconds
  → 汇总：N 任务，总 ~S 秒，预计 ~S×单价 灵石，二次确认
  → 逐 pair：
     bridge_submit_video(image, video, seconds, tier)  # 经桥：扣费→转发 RBFLow
        ├─ 200 {task_id, call_log_id} → 建 Task(PENDING)，入 QueuePanel
        ├─ 402 insufficient_balance → 拦截，提示余额不足，停止后续提交
        └─ 其他错误 → 卡片标红
     → 启 ProgressWorker：bridge_stream(task_id) 桥代理 SSE
        ├─ progress → 更新进度环
        ├─ done → SUCCESS，启 DownloadWorker
        └─ error → FAILED，自动重试开关控制
  → DownloadWorker：bridge_download(task_id) → 落盘命名模板路径
```

### 3.6 容错

- FAILED-but-ready：卡片「重新下载」→ 桥 `/video/download`（代理 `/redownload`）。
- SSE 断连：退避重连(≤5) → 超限转桥轮询。
- 421 TASK_QUEUE_MAXED：自动重试开关延迟重提。
- **计费-转发原子性**：桥转发 RBFLow 失败 → 退款（凭 call_log_id）；relay 提供 `/videos/refund`。

## 4. 兼容性 / 回归

- 现有 chat/image relay：`executeRelay` 零改动，视频独立方法。
- `PER_SECOND` 是 Prisma enum 加法；现有 PER_TOKEN/CALL/IMAGE 不受影响（computeCredits 新增 case）。
- 现有插件只声明 image/llm，不受 `video.generate` 影响。
- 桥新增 flag 是加法，老 `register_session` 调用方未传 → 默认 false。
- Prisma：`PricingUnit` enum 加值需 migration（`PER_SECOND`）；`LlmCallLog.capability` 是 String，'video' 无需迁移。

## 5. 测试策略

| 层         | 测试                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| contract   | `validateManifest` 对 `video.generate` 通过；`PricingUnit` 含 PER_SECOND                                          |
| pricing    | `computeCredits('PER_SECOND', price, {seconds:10})` = price×10；0秒 clamp 到 1                                    |
| relay      | `videoGenerations`：扣费成功 / 402 / 无定价 503 / refund                                                          |
| bridge     | Rust 测试：gate 403；计费失败不转发 RBFLow（mock relay 402）；计费成功转发 RBFLow（mock）；RBFLow 失败触发 refund |
| **防绕过** | 断言插件进程 env 无 `LINGFANG_RBFLOW_*`；插件无法直连 RBFLow（无地址）                                            |
| 插件       | 手动 QA（三栏美化 + 端到端扣费→转发→进度→落盘）                                                                   |

## 6. 风险与缓解

- **风险**：计费成功但 RBFLow 转发失败 → 扣费无服务。
  **缓解**：桥捕获转发失败 → 调 relay `/videos/refund` 退款（凭 call_log_id）；relay videoGenerations 加退款幂等。
- **风险**：用户篡改 seconds 传小值少扣费。
  **缓解**：seconds 由插件 ffprobe 探测，但插件在用户机器可篡改。**桥/relay 不信任插件上报的 seconds**——由桥侧重新探测？桥（Rust）探测需 ffprobe。MVP：信任插件 + relay clamp(≥1秒) + 审计（requestSummary 记 seconds，异常值后台筛）。**长期**：桥侧用 ffprobe 重探测（需桌面带 ffprobe）。
- **风险**：视频文件大（数百 MB）经桥转发 OOM。
  **缓解**：streaming 转发（reqwest stream body），不全量载内存；600s 超时。
- **风险**：PySide6 wheel 在某些 Windows 路径超 260 字符。
  **缓解**：`plugin_runner.rs` 已有短路径缓存（`:13`），沿用。
