# 执行计划：插件运行崩溃展示 stderr

## 步骤 1：Rust start_plugin 改 stderr + 秒退判定

`apps/desktop/src-tauri/src/plugin_runner.rs` start_plugin（line 548-590）：

- `.stderr(Stdio::null())` → `.stderr(Stdio::piped())`（stdout 保持 null）。
- spawn 后加秒退判定：try_wait 轮询 800ms（50ms 间隔）。
  - 退出 = 崩溃：take stderr + read_to_string，返回 `plugin_crashed:<status>\n<stderr 摘要>`。
  - 存活 = 正常：take stderr 交后台线程排空（read 丢弃），register process_table，返回 pid。
- 加 `truncate_stderr(s: &str) -> String`：截断到 2000 字符（超长加 `…(截断)` 尾）。
- import：`std::time::{Instant, Duration}`、`std::io::Read`。

## 步骤 2：单测

`plugin_runner.rs` 测试模块加秒退判定测试：

- 造一个秒退的「插件」（python `-c "raise SystemExit(1)"` 或用 echo 假 binary）→ 验证 start_plugin 返回 `plugin_crashed:` 前缀。
- 注意：start_plugin 依赖 PluginStore + ensure_python_venv，单测难直接调。改为抽出 `wait_for_crash(child) -> Option<String>` 纯函数测：spawn 一个 sleep 进程（存活）→ None；spawn 一个立即退的进程 → Some(stderr)。

## 步骤 3：前端 creator-error + ScriptPreviewPanel

- `apps/desktop/src/lib/creator-error.ts`：加 `plugin_crashed` kind + TITLE/DETAIL/RETRYABLE 映射（标题「插件启动后立即退出」，retryable=false）。
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx` handleStart：加 `plugin_crashed:` 前缀分支 → `toCreatorError('plugin_crashed', ...)`，错误对象保留 stderr raw 供一键修复用。

## 步骤 4：一键让 AI 修复（R7/R8）

- `ScriptPreviewPanel.tsx`：
  - 加 `onRequestFix?: (stderr: string) => void` prop。
  - plugin_crashed 错误卡片（ErrorBubble）加「让 AI 修复」按钮：点击调 `onRequestFix(error.raw || '')`。无 onRequestFix 时不显示按钮。
- `PluginCreatorHome.tsx`：
  - 加 `handleAutoFix(stderr: string)`：构造 prompt（`插件运行时报错，请定位并修复：\n\`\`\`\n${stderr}\n\`\`\`\n请修复并重新写出完整文件。`）→ 调 `send(prompt)`（复用追问路径）。
  - 传 `onRequestFix={handleAutoFix}` 给 ScriptPreviewPanel。
  - 按钮禁用判断：会话不可续接（`!activeId || assistantSession?.status === 'running'`）时 onRequestFix 传 undefined（按钮不显示）或 handleAutoFix 内 toast 提示。

## 验证命令

- Rust：`cargo test -p lingfang-desktop`（plugin_runner 模块 + 新 wait_for_crash 测试）
- 前端：`pnpm -C apps/desktop typecheck`
- 手动：造一个启动即异常的 Python 插件（如 main.py 顶层 raise）→ 点运行 → 看到 stderr 异常展示 → 点「让 AI 修复」→ AI 修复 → 再运行验证通过。

## 实现顺序

1. 步骤 1（Rust start_plugin）+ 步骤 2（wait_for_crash 单测）→ cargo test
2. 步骤 3（前端 stderr 展示）→ typecheck
3. 步骤 4（一键修复）→ typecheck
4. 手动验证（异常插件 + 一键修复闭环 + 正常插件）

## 风险与回滚点

- 800ms 超时误判慢启动 → 调大或 retryable=true。回滚 = 还原 stderr null + 删轮询。
- 后台排空线程泄漏 → 进程退出自然结束。回滚 = 删线程。
- plugin_crashed 前缀前后端一致（核对）。
