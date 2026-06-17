# 技术设计：插件运行崩溃展示 stderr

## 架构与边界

改 Rust start_plugin 的 stderr 处理 + 前端错误展示，改动范围：

- `apps/desktop/src-tauri/src/plugin_runner.rs` — start_plugin：stderr 改 piped + spawn 后秒退判定。
- `apps/desktop/src-tauri/src/plugin_runner.rs` — StartPluginResult 可能加 crashed 字段，或直接返错误。
- `apps/desktop/src/lib/creator-error.ts` — 新增 `plugin_crashed` kind。
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx` — handleStart catch `plugin_crashed:` 前缀。

## 核心设计：spawn 后秒退判定 + stderr 捕获

当前：`stderr(Stdio::null())` + spawn 后立即返回 pid。

改为：

```rust
.stderr(Stdio::piped())  // 捕获异常（stdout 仍 null，符合 PRD 需求 9）
// ... spawn ...
let mut child = command.spawn()?;

// 短等待判定秒退：用 try_wait 轮询 ~800ms（避免 wait 阻塞——GUI 正常启动会一直跑）。
let deadline = Instant::now() + Duration::from_millis(800);
let mut crashed_stderr = String::new();
loop {
    match child.try_wait()? {
        Some(status) => {
            // 进程已退出 = 崩溃（正常 GUI 不会 800ms 内退）。读 stderr 全部内容。
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let mut buf = String::new();
                let _ = stderr.read_to_string(&mut buf);
                crashed_stderr = buf;
            }
            return Err(format!("plugin_crashed:插件启动后立即退出（{}）\n{}", status, truncate_stderr(&crashed_stderr)));
        }
        None => {
            if Instant::now() >= deadline { break; }  // 存活 800ms = 正常运行
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
// 存活 = 正常运行：stderr pipe 必须排空，否则 pipe 满阻塞进程。
// 交后台线程持续读 stderr 丢弃（GUI 正常运行时 stderr 一般空或少量输出，排空防阻塞）。
let plugin_id_clone = plugin_id.clone();
let mut stderr = child.stderr.take();
std::thread::spawn(move || {
    if let Some(mut s) = stderr {
        let mut buf = [0u8; 1024];
        loop {
            use std::io::Read;
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,  // 进程退出或 pipe 关闭
                _ => { /* 丢弃，不进 UI */ }
            }
        }
    }
});
let pid = process_table.register(&plugin_id, child, started_at);
Ok(StartPluginResult { pid, started_at })
```

**关键点**：
1. `try_wait` 轮询（非 `wait` 阻塞）——GUI 正常启动会一直跑，wait 会阻塞 start_plugin 命令 800ms+，try_wait + sleep 轮询可控制超时。
2. 秒退才读 stderr（child 已退出，stderr 可 read_to_string 一次读完）。
3. 正常运行时 stderr 交后台线程排空（防 pipe 满阻塞进程）——读后丢弃，不进 UI（符合 PRD 需求 9）。
4. `truncate_stderr`：stderr 可能很长（含 traceback），截断到合理长度（如 2000 字符）避免错误信息过长。

## stderr pipe 生命周期

- 秒退：child 退出，stderr 在主线程 read_to_string 读完，child drop。
- 正常运行：stderr take 出来交后台线程，后台线程在进程退出时 read 返回 0 自然结束。child 句柄仍由 process_table 持有（stop_plugin 用）。

**注意**：take stderr 后 child.stderr=None，不影响 process_table 的 kill/wait（kill 用 pid/handle，不依赖 stderr）。

## 前端错误展示

- `plugin_crashed:` 前缀（与 manifest_missing/interpreter_missing 同款）。
- creator-error.ts 加 `plugin_crashed` kind：标题「插件启动后立即退出」，detail「插件代码运行时抛出异常，请查看下方错误信息定位并修复（或点「让 AI 修复」自动修）」，raw 放 stderr 原文，retryable=false（需先修代码）。
- ScriptPreviewPanel.handleStart 加 `plugin_crashed:` 前缀分支。

## 一键让 AI 修复（R7/R8）

**设计思路**：创建器已有追问机制——`send(text)`（PluginCreatorHome.tsx:700）的追问路径（line 708-731）走 `code_assistant_send_input` --resume 续接，AI 在原会话上下文（它生成过插件代码）继续。send 已支持外部传入 text 参数，一键修复只需构造修复 prompt 调 send。

**链路**：
1. ScriptPreviewPanel 的 plugin_crashed 错误卡片加「让 AI 修复」按钮。
2. 点击 → 调 `onRequestFix(stderr)` callback（stderr 来自 plugin_crashed 错误的 raw）。
3. PluginCreatorHome 实现 `handleAutoFix(stderr)`：
   - 构造 prompt：`插件运行时报错，请定位并修复：\n\`\`\`\n${stderr}\n\`\`\`\n请修复问题并重新写出完整文件。`
   - 调 `send(prompt)`（复用既有追问路径，走 send_input --resume）。
4. AI 在原会话 resume，看到 stderr，修代码，重写文件（mergeFollowupDraft/WithSandbox 累积）。
5. 用户再点运行验证。

**ScriptPreviewPanel 接口**：加 `onRequestFix?: (stderr: string) => void` prop。有此 prop 时错误卡片显示「让 AI 修复」按钮，无则不显示（从插件页独立运行崩溃时无会话上下文，不显示按钮）。

**边界（R8）**：
- 会话能 resume（activeId 存在 + assistantSession 已 exited）→ 按钮可用，send 走追问路径。
- 会话不可 resume（无 activeId / 首轮仍 running / degraded 无 cli_session_id 但 send_input 仍可发伪多轮）→ send 内部会自行分流：有 activeSessionId+exited 走追问，否则走首轮 start_session（等于新会话重述问题）。一键修复前可校验 activeId 存在，不存在则按钮禁用 + 提示「该会话已不可续接，请重新创建」。
- 实际上 send 已处理分流，handleAutoFix 直接调 send 即可；按钮禁用判断 = `!activeId || assistantSession?.status === 'running'`。

**复用 vs 新建**：不新建 sendFollowup，直接复用 send(text)。send 的追问路径已含 cliConfig/systemPrompt/effort 注入，一键修复走同路径行为一致。

## 兼容性与回滚

- stderr null→piped：仅影响 stderr 捕获，stdout/进程组/kill 逻辑不变。回滚 = 还原 null + 删轮询。
- 后台排空线程：进程退出自然结束，无泄漏。回滚 = 删线程。
- 前端 plugin_crashed kind 新增，无对应分支走默认。回滚 = 还原 handleStart。

## 风险点

- 800ms 超时对慢启动插件（首次 import 大库）可能误判秒退。可调大到 1500ms，或仅 Python/Node 通用。实测 PySide6 首次启动 ~500ms，800ms 够。若误判，用户看到「秒退」提示可重试（retryable 可设 true）。
- try_wait 轮询 50ms 间隔 × 16 次 = 800ms，CPU 开销可忽略。
- 后台排空线程若 panic 不影响主进程（独立线程）。
