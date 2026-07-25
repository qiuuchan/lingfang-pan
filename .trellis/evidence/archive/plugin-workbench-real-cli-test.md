# 插件工作台真实 CLI 手测记录

## 当前结论

状态：`BLOCKED`

原因：真实 CLI 门禁未全部跑通。

- Claude Code：已发现并能读取版本；最小响应 prompt 超时。
- Codex：已发现 npm 包入口并完成真实最小响应；默认模型返回 `lingfang-cli-ok`；Tauri session 自然完成与取消路径通过。
- OpenCode：已发现并能读取版本；最小响应 prompt 超时。

按照验收定义，三个 CLI 没有全部真实完成最小响应、生成插件草稿、云端上传、运行/预览、停止/清理之前，不能标记完成。

## 测试环境

- 工作目录：`/Users/littlesheep/Desktop/lingfang`
- OS：`macOS-26.5-arm64-arm-64bit-Mach-O`
- 记录时间：2026-06-12 当前会话
- 测试方式：直接调用真实本机 CLI 二进制；没有使用 mock、fixture 或静态返回。

## Claude Code

### 发现与版本

- 二进制：`/Users/littlesheep/.local/bin/claude`
- 命令：`/Users/littlesheep/.local/bin/claude --version`
- 退出码：`0`
- 输出：`2.1.162 (Claude Code)`
- 耗时：`485ms`

### 最小响应

- 命令：`/Users/littlesheep/.local/bin/claude -p "Reply with exactly: lingfang-cli-ok"`
- 结果：失败
- 退出码：无，进程被超时终止
- 超时：`60017ms`
- stdout：空
- stderr：空

### 端到端项

- 生成插件草稿：未完成，阻塞于最小响应。
- 云端上传：未执行。
- 运行/预览：未执行。
- 停止/清理：超时进程由测试脚本终止。
- 云端 plugin id：无。
- 审核状态：无。

## Codex

### 发现与版本

- 裸 `codex`：当前登录 shell 未发现。
- npm 包入口：`npx --no-install @openai/codex`
- 命令：`npx --no-install @openai/codex --version`
- 退出码：`0`
- 输出：`codex-cli 0.139.0`
- 运行时适配：桌面 Tauri 运行时已支持 `codex` 与 `npx --no-install @openai/codex` 两种入口；未发现裸二进制时会降级到 npm 包入口。

### 最小响应

#### 指定不可用模型失败记录

- 命令：`npx --no-install @openai/codex exec "Reply with exactly: lingfang-cli-ok" --model gpt-5.1-codex`
- 结果：失败
- 退出码：`1`
- 耗时：`47084ms`
- session id：`019eba39-e109-70c2-b873-b0999b7cb400`
- 错误：`unexpected status 422 Unprocessable Entity: model not found: gpt-5.1-codex`

#### 默认模型成功记录

- 命令：`npx --no-install @openai/codex exec "Reply with exactly: lingfang-cli-ok"`
- 结果：成功
- 退出码：`0`
- 耗时：`46216ms`
- 模型：`gpt-5.5`
- provider：`CodexPilot`
- session id：`019eba3b-042a-75e3-962c-2569d68165b7`
- stdout：`lingfang-cli-ok`
- stderr 摘要：`OpenAI Codex v0.139.0`，`tokens used 3,197`

### 长任务 session 生命周期验证

#### 自然完成路径

- 命令：`LINGFANG_REAL_CODEX_SESSION_TEST=1 cargo test -p lingfang-desktop real_codex_session_lifecycle_when_enabled -- --nocapture`
- 结果：成功
- 退出码：`0`
- 耗时：`21.16s`
- provider/model：Codex 默认模型
- session id：`codex-1781262276-717226000`
- transcript：`/var/folders/3k/l9pctdtd7s14_b3q57lw1ks40000gn/T/lingfang-real-codex-session-20098/transcripts/codex-1781262276-717226000.jsonl`
- 命令预览：`/Users/littlesheep/.nvm/versions/node/v22.22.3/bin/codex exec Reply with exactly: lingfang-long-session-ok`
- session 状态：`exited`
- 退出码：`Some(0)`
- registry 清理：`registry_remaining=0`
- transcript 校验：包含 `lingfang-long-session-ok`

#### 取消/停止路径

- 命令：`LINGFANG_REAL_CODEX_STOP_TEST=1 cargo test -p lingfang-desktop real_codex_session_stop_when_enabled -- --nocapture`
- 结果：成功
- 退出码：`0`
- 耗时：`3.12s`
- provider/model：Codex 默认模型
- session id：`codex-1781262260-601914000`
- transcript：`/var/folders/3k/l9pctdtd7s14_b3q57lw1ks40000gn/T/lingfang-real-codex-stop-18803/transcripts/codex-1781262260-601914000.jsonl`
- 命令预览：`/Users/littlesheep/.nvm/versions/node/v22.22.3/bin/codex exec Write a detailed LingFang plugin design with at least 20 sections. Do not be brief.`
- session 状态：`stopped`
- 退出码：`None`
- registry 清理：`registry_remaining=0`
- transcript 校验：包含 `stopped`
- 真实问题与修复：首次取消路径暴露出 waiter 持锁等待导致 `stop_session` 无法抢到进程句柄，以及 macOS `kill` 对负进程组参数需要 `--` 分隔；已改为非阻塞轮询 waiter，并使用进程组 TERM/KILL 清理。

### 端到端项

- 生成插件草稿：已从阻塞式 probe 改为真实 session 生命周期；Codex 默认模型自然完成和取消路径均通过真实 Tauri runtime 测试。完整插件生成仍需更长运行预算和后续 UI 内人工验收。
- 云端上传：已通过真实协作后端 API 上传派生测试插件。
- 运行/预览：前端已完成首页、详情抽屉和浏览器边界 E2E；Tauri WebDriver 未安装，未完成桌面 WebView 内自动点击发送。
- 停止/清理：Codex 真实 session 取消路径已验证为 `stopped`，transcript 保留，registry 清理为 `0`。
- 云端 plugin id：`6ef7eb56-a699-46d0-b84f-84358d347a65`
- 审核状态：已提交市场审核并由平台管理员测试账号审核通过，最终 `APPROVED` / `PUBLIC`。
- 证据：`docs/evidence/plugin-workbench-app/api-cloud-flow.json`（截图已清理，仅保留可重放的结构化证据）。

## OpenCode

### 发现与版本

- 二进制：`/opt/homebrew/bin/opencode`
- 命令：`/opt/homebrew/bin/opencode --version`
- 退出码：`0`
- 输出：`1.2.27`
- 耗时：`1725ms`

### 最小响应

- 命令：`/opt/homebrew/bin/opencode run "Reply with exactly: lingfang-cli-ok"`
- 结果：失败
- 退出码：无，进程被超时终止
- 超时：`60020ms`
- stdout：空
- stderr：空

### 端到端项

- 生成插件草稿：未完成，阻塞于最小响应。
- 云端上传：未执行。
- 运行/预览：未执行。
- 停止/清理：超时进程由测试脚本终止。
- 云端 plugin id：无。
- 审核状态：无。

## App 真实测试记录

### 桌面运行态

- 命令：`pnpm -C apps/desktop dev`
- Tauri 进程：`target/debug/lingfang-desktop`，本轮确认 PID `86335` 正在运行。
- Vite dev server：`http://localhost:1420/` 返回 `200 OK`，页面大小 `567 bytes`。
- 协作后端：`http://localhost:3001/api/health` 返回 `{ "status": "ok", "service": "collab-api" }`。（注：当时为临时 `PORT=3001` 启动，默认端口为 `3000`，详见 docs/collab-deployment.md。）
- Tauri WebDriver：当前 Tauri CLI 没有 `driver` 子命令，本机只有 `safaridriver`，因此本轮自动化点击使用 Chrome DevTools 覆盖同源前端；桌面宿主运行态用 Tauri 进程、Vite 端口、Rust 命令测试和真实 CLI 调用证据确认。

### 浏览器交互 E2E

- 测试方式：Google Chrome DevTools Protocol，真实打开 `http://localhost:1420/`，不使用 mock 页面。
- 测试账号：`plugin-e2e-20260612062307@lingfang.test`
- 团队：`5560f60e-47bf-45f6-81b2-8b0075b28ce2`
- 覆盖路径：已保存后端地址状态 → 登录 → 进入插件创建首页 → 验证单一主对话框 → 打开右侧详情抽屉 → 验证空草稿状态和上传按钮禁用 → 在浏览器环境点击发送并确认 Tauri 边界错误。
- 结果：通过。
- console：`consoleErrorCount = 0`，只剩 Vite/React DevTools 提示，无 React warning、无 runtime exception。
- 本轮真实测试发现并修复：`SheetTrigger` / `SheetClose` 通过 `render={<Button />}` 传 ref 时，`Button` 没有 `forwardRef` 导致 React warning；已将 `Button` 改为 `React.forwardRef`，重新测试后 console 错误数为 0。
- 证据（截图已清理，仅保留可重放的结构化证据）：
  - `docs/evidence/plugin-workbench-app/app-e2e-summary.json`
  - `docs/evidence/plugin-workbench-app/network-requests.json`
  - `docs/evidence/plugin-workbench-app/console.json`

### 云端插件分享 API E2E

- 上传接口：`POST /api/plugins/upload`
- 插件 ID：`4e5ee214-8a28-4190-b1b5-f2fb959690df`
- 上传结果：`DRAFT`，`source=team`，团队可用列表包含该插件。
- 市场提交：`POST /api/plugins/:id/submit-marketplace`，结果 `PENDING`。
- 审核账号：`plugin-admin-1781245387677@lingfang.test`
- 审核接口：`POST /api/admin/plugins/:id/approve`
- 审核结果：`APPROVED`，`marketplace=true`，`visibility=PUBLIC`。
- 我的插件列表：包含该插件。
- 证据：`docs/evidence/plugin-workbench-app/api-cloud-flow.json`

## 下一次继续验证前置条件

1. Claude Code 非交互 `-p` 模式仍需返回真实响应，或定位其认证/模型配置问题。
2. OpenCode `run` 模式仍需返回真实响应，或定位其认证/模型配置问题。
3. Codex 已通过默认模型最小响应与 Tauri session 生命周期验证；后续端到端流程应使用默认模型或实际可用模型，不再默认强制 `gpt-5.1-codex`。
4. 三者最小响应通过后，再继续执行：真实生成完整插件草稿 → 上传 `/api/plugins/upload` → 插件页运行/预览 → 提交市场审核 → 管理端审核记录。

