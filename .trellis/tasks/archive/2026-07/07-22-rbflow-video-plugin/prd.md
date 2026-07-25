# RBFLow 动作迁移视频生成插件（平台运营实例 + 灵石按秒计费 + 防绕过）

## Goal

把平台运营的 RBFLow 服务（RunningHub ComfyUI 动作迁移工作流）封装成灵坊平台的 **PySide6（Qt6）插件**：用户上传「参考图片 + 参考视频」→ 经平台桥**按视频时长（秒）扣灵石** → 桥代理转发到平台运营的 RBFLow 实例生成视频 → 实时进度 → 落盘保存到用户指定本地文件夹。UI 参考「AI视频制作工作流管理器」截图的三栏布局并做现代深色美化。

## Background

- **RBFLow**：FastAPI 服务，封装 RunningHub `WanAnimateToVideo` 工作流（workflow_id `2077306530982088706`）。接收 image+video multipart → 替换工作流节点（`nodeId=78` image / `nodeId=77` video）→ SSE 进度 → 成品 `{图片名}_{视频名}.mp4`。含 JWT + 静态 `X-API-Key` 鉴权（`app/auth/dependencies.py`，hmac 常量比较，单管理员模型）。**由平台方统一运营部署一个实例，所有用户共用**。
- **平台桥**：桌面 Tauri 注入 `LINGFANG_PLUGIN_BRIDGE_URL`/`TOKEN`，插件所有 AI 调用走本地桥 → relay → 按团队灵石扣费（reserve/reconcile 两阶段）。当前桥只有 `/llm/chat`、`/image/generate`、`/image/edit` + OpenAI 兼容 `/v1/*`，**无视频计费能力**。
- **现有计费单元**：`PricingUnit` enum 只有 `PER_TOKEN_INPUT/OUTPUT`、`PER_CALL`、`PER_IMAGE`（`prisma/schema.prisma:312`）。**无按秒单元**。

## 安全威胁模型（驱动架构的核心）

**威胁**：若插件持有 RBFLow 凭证（URL+API-KEY），用户可从配置/内存/网络层拿到 → 自己写脚本直连 RBFLow `/api/v1/tasks` → **完全绕过灵石计费**。这是「客户端持有凭证 = 计费可被绕过」的根本漏洞。

**对策（已确认）**：RBFLow 凭证**只放平台侧**（用户不可见）。插件**不持有、不感知** RBFLow 地址——它只调平台桥。桥 `/video/generate` **先按秒扣灵石，再代理转发到平台运营的 RBFLow 实例**。用户没有任何 RBFLow 凭证 → **物理上无法绕过计费**（强保证，非混淆劝退）。

> 这推翻了初版「连接外部实例 / 插件持凭证 / 桥纯扣费不转发」的范围。平台运营实例 + 桥代理转发 是更安全、更简洁的最终架构。

## Scope（两个交付物）

### 交付物 A：平台视频计费 + 桥代理转发（基础设施，必须先行）

- 新增 capability kind `video.generate`（contract + 桥 session flag + 两处 runner/script 调用方 + SDK 路由表）
- 新增计费单元 `PER_SECOND`（Prisma enum + pricing service computeCredits + seed 契约）
- 桥新增 `/video/generate` 路由：gate → **按秒计费**（relay 预扣 reserve + 实算 reconcile）→ **代理转发到平台运营 RBFLow**（注入平台侧 RBFLow URL+API-KEY，插件不可见）→ 返回 RBFLow task_id + 扣费票据
- bridge 新增 RBFLow 转发实现（复用现有 `build_image_edit_multipart` multipart 模式，含 image+video 两文件）；新增 SSE 进度透传路由 `/video/stream`（桥代理 RBFLow SSE，插件不直连 RBFLow）
- 价目表 seed 一条 `capability='video'`、`unit='PER_SECOND'`、`pricePerUnit=N`（N 灵石/秒）的定价行
- 平台侧 RBFLow 配置：RBFLow base_url + api_key 作为平台设置项（不入插件 manifest，不注入插件 env）

### 交付物 B：RBFLow 动作迁移视频生成插件（PySide6 + 美化 UI）

PySide6（Qt6）三栏桌面插件，**只调平台桥，不直连 RBFLow**。

- **左栏「图片输入区」**：选图片/选文件夹上传、文件夹分类（新建/刷新）、已上传图片多选列表（缩略图+勾选+预览+删除+移动分类）、全选/反选/未选
- **中栏「参考视频区」**：上传参考视频、文件夹分类、视频多选列表、工作流节点配置（图片节点ID=78/图片字段=image/视频节点ID=77/视频字段=video，默认预填）
- **右栏「输出区/任务队列」**：任务总数 + 状态统计、状态筛选 tab、自定义输出文件夹（浏览/记忆）、任务卡片（关联图片+视频、进度、状态、时间戳、操作）、批量操作、自动重试/刷新开关
- **提交逻辑**：选图 × 选视频笛卡尔积 → **ffprobe 探测每个视频时长（秒）** → 桥 `/video/generate` 按 `单价×秒` 扣灵石 → 桥代理提交 RBFLow → 桥 `/video/stream` 代理 SSE 进度
- **结果保存**：done 后经桥下载成品 mp4 落盘到自定义文件夹（按日期/分类子目录），支持「另存为」
- **美化 UI**：现代深色主题 QSS + 圆角卡片 + 阴影 + 进度环 + 状态色标 + 自定义控件（对照截图暗色三栏风）
- **无 RBFLow 配置项**：插件设置只有「输出目录 + 节点配置 + 计费档位」，**不含任何 RBFLow URL/KEY**（凭证在平台侧，用户不可见）

## Requirements

### 功能需求

1. **R1 计费链路（防绕过）**：插件一切 RBFLow 调用必经平台桥；桥先扣灵石再转发；用户无 RBFLow 凭证，**物理上无法绕过计费直连 RBFLow**。
2. **R2 按秒计费**：插件用 `ffprobe`/`moviepy` 探测参考视频时长（秒），连同 image+video 文件经桥 `/video/generate` 提交；relay 按 `PER_SECOND` 单价 × 秒数扣灵石；余额不足（402）时桥不转发、插件拦截提示。
3. **R3 队列排序**：本地任务队列支持手动排序（拖拽/上移/下移/置顶）+ 按状态筛选。
4. **R4 自定义文件夹**：输出目录可浏览选择并记忆；按「日期/图片分类/视频分类」自动建子目录（参考截图路径 `...结果视频\2026-7-14\other\左提包`）。
5. **R5 多素材笛卡尔积**：N 图 × M 视频 = N×M 任务；提交前显示预计任务数、总秒数、预计灵石消耗。
6. **R6 实时进度**：调桥 `/video/stream`（桥代理 RBFLow SSE）推 progress/done/error，右栏卡片实时更新。
7. **R7 保存到本地**：done 后经桥下载 mp4 落盘到自定义文件夹；失败任务不落盘。
8. **R8 容错**：FAILED-but-video-ready 经桥调 `/redownload`；SSE 断连重连；421 并发满自动重试（开关）。
9. **R9 持久化**：任务列表与配置持久化（`data/`），重启不丢。
10. **R10 美化 UI**：PySide6 + 现代深色 QSS 主题；圆角卡片、阴影、进度环、状态色标、hover/press 交互态；对照截图三栏视觉。

### 非功能需求 / 约束

- **C1 零密钥（强化）**：插件**完全不持有任何 RBFLow / RunningHub 凭证**。RBFLow URL+API-KEY 仅平台侧配置，不注入插件 env、不进 manifest。插件只调桥。
- **C2 PySide6（Qt6）**：用 `PySide6>=6.7`（与 `videodl`/`facefusion` 一致），不用 PyQt5/PyQt6。沿用 `plugin_runner.rs` 对 PySide6 深层 wheel 的短路径缓存优化。
- **C3 按秒计费契约**：新增 `PER_SECOND` 是 Prisma enum + pricing + seed 三处协同改动；不影响现有 PER_TOKEN/PER_CALL/PER_IMAGE。
- **C4 不改既有计费账本/relay chat-image 链路**：视频是新独立路径。
- **C5 大文件转发**：视频可能数百 MB，桥转发用 `relay_post_raw` 同款 600s 超时 + streaming，避免 OOM。

## Acceptance Criteria

### 交付物 A（平台视频计费 + 桥代理转发）

- [ ] `manifest.json` 声明 `video.generate` 通过 `validateManifest`。
- [ ] `PER_SECOND` 计费单元：relay 按 `单价×秒` 扣灵石（reserve→reconcile，写 `LlmCallLog` usage 含 seconds）；余额不足 402；异常 refund。
- [ ] 桥 `/video/generate`：gate `allow_video_generate` → 按秒计费 → **注入平台侧 RBFLow 凭证转发** image+video multipart → 返回 `{task_id, call_log_id, charged, credits}`。
- [ ] 桥 `/video/stream`：代理 RBFLow SSE 透传给插件（插件不直连 RBFLow）。
- [ ] **防绕过验证**：插件进程 env 无任何 RBFLow 凭证；插件无法在不知 RBFLow 地址的情况下直连 RBFLow。
- [ ] 现有 chat/image relay 链路与扣费回归不破坏。
- [ ] seed 价目表含视频按秒条目；管理端可改单价。

### 交付物 B（RBFLow 插件）

- [ ] PySide6 三栏窗口对照截图 + 现代深色美化主题（圆角卡片/阴影/进度环/状态色标）。
- [ ] 左栏选图/文件夹、上传、多选、删除、移动分类、缩略图预览可用。
- [ ] 中栏上传视频、多选、节点配置（默认 78/image、77/video）可用。
- [ ] 提交：ffprobe 探测时长 → 笛卡尔积 → 显示预计灵石 → 扣费（402 拦截）→ 桥转发 RBFLow → 右栏出卡片。
- [ ] 右栏：统计、状态 tab、卡片进度实时（经桥 SSE）、排序、操作可用。
- [ ] 自定义输出文件夹：完成视频落盘（含日期/分类子目录）；另存为可用。
- [ ] 重启恢复任务列表与配置。
- [ ] **插件设置不含任何 RBFLow URL/KEY 字段**（凭证平台侧，用户不可见）。

## Out of Scope

- 不做用户自部署 RBFLow（平台统一运营单实例；未来可加「外部实例」高级模式）。
- 不做 RBFLow 管理面板复刻。
- 不做顺序配对模式（笛卡尔积为主）。
- 不做失败退款端点（MVP 扣费不可逆；记为后续，凭 call_log_id 可加）。
- 不修改 RBFLow 服务端代码。

## Resolved Decisions（已与用户确认）

1. **Qt6 框架**：PySide6（非 PyQt6），与 `videodl`/`facefusion` 一致。
2. **UI 美化**：现代深色主题 QSS + 自定义控件。
3. **计费方式**：按秒（新增 `PER_SECOND`），**单价 0.5 灵石/秒**（seed 写入，管理端可后改）。已验证可行：`TeamCredit.balance` 是 `Float`（`schema.prisma:2211`），`roundCredits` 保留两位小数（`credit.service.ts:19`），小数扣费链路自洽，无需改计费基础设施。
4. **秒数采信策略**：**信任插件 ffprobe 上报 + 审计**（MVP）。relay 对 seconds clamp(≥1)；后台审计 requestSummary 中异常偏小值。不改桥侧（不要求桌面内置 ffprobe）。
5. **RBFLow 凭证位置**：平台侧配置（用户不可见）；桥代理转发 RBFLow；用户物理上无法绕过计费。
6. **RBFLow 归属**：平台统一运营的单一实例，所有用户共用。

## RBFLow v0.4 对接更新（重新读取后同步）

RBFLow 已升级到 v0.4.1，对本插件方案的影响：
- **下载**：改用 `GET /tasks/{id}/download`（流式 mp4 blob，`tasks.py:311`）替代旧的 `/result` 302 重定向——桥代理转发更干净。
- **SSE 字段**：v0.4 已改名 `node`/`node_progress`（原 `current_node`）——插件 SSE 解析须对齐 v0.4。
- **提交**：`POST /tasks` 支持 `priority` 字段（0-100，`tasks.py:73`）——桥转发时可透传，插件队列排序可映射到 RBFLow 优先级。
- **历史日志**：新增 `GET /tasks/{id}/logs`（持久化步骤日志，`tasks.py:409`）——插件卡片可展示完整历史（即使后连也能回放）。
- **新状态**：`COMPLETED_OUTPUT_PENDING`（视频生成中）+ `error_code`/`error_advice` 结构化错误——卡片状态与错误信息更精准。
- **批量重试**：`POST /tasks-batch/retry`（`tasks.py:384`）——可选用于插件批量操作。
