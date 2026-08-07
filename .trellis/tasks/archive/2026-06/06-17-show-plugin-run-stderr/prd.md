# 插件运行崩溃展示 stderr + 一键让 AI 修复

## Goal

插件运行（start_plugin）崩溃时，用户只看到「无法启动」/「运行中」，看不到 Python/Node 真实异常，无法定位是插件代码 bug。两步改进：

1. **展示 stderr**：spawn 后短暂等待判定是否秒退，秒退则捕获 stderr 展示给用户（如 `AttributeError: 'str' object has no attribute 'value'`）。
2. **一键修复**：错误卡片加「让 AI 修复」按钮，把 stderr + 修复指令作为追问送回创建器的 AI 会话（走 send_input --resume），AI 在原上下文（它生成过插件代码）里定位修复、重写文件，用户再运行验证。

实测案例：AI 生成的 PySide6 插件 main.py line 699 `m.value` 重复取值（MODE_MAP 已是字符串），启动即 `AttributeError` 崩溃，用户只看到「无法启动」，看不到异常，误以为平台问题。手动修插件代码后正常。有了这两步，用户能直接看到异常并一键让 AI 修。

## 已确认事实（来自代码查证）

- **start_plugin**（`plugin_runner.rs:466`）：spawn 后立即返回 pid（line 590），不等待结果。进程秒退不会反馈前端。
- **Stdio::null**（line 557-558）：stdout/stderr 完全丢弃，进程崩溃的 Python 异常看不到。
- **前端**（`ScriptPreviewPanel.handleStart`）：startPlugin 成功返回就 `setPersistentRun({status:'running'})`，即使进程已秒退，UI 仍显示「运行中」。
- **detached 设计意图**（line 550 注释）：PRD 需求 9「不在软件 UI 内嵌入终端输出」，GUI 插件自弹窗口。stdout 保持 null 合理；但 **stderr 丢弃导致崩溃无反馈**是缺陷。
- **spawn 后短等待可行性**：spawn 返回 Child，可 `child.wait()` 配合超时（或 try_wait 轮询）判定秒退。GUI 插件正常启动会一直运行（wait 阻塞需超时）。
- **进程表**（PluginProcessTable）：register 后存 Child 句柄，秒退的 Child 仍可 wait 取 status + stderr。

## Requirements

- R1 start_plugin 的 stderr 改 `Stdio::piped`（捕获异常），stdout 保持 `Stdio::null`（GUI 输出不进 UI，符合 PRD 需求 9）。
- R2 spawn 后短等待（如 800ms）判定是否秒退：
  - 未退（进程活着）= 正常运行，返回 pid（与现在一致）。stderr pipe handle 交后台线程异步排空（防 pipe 满阻塞进程）或关闭。
  - 秒退 = 崩溃，读取 stderr 全部内容，返回结构化错误（`plugin_crashed:<stderr 摘要>` 前缀，与 manifest_missing 同款约定）。
- R3 前端 `handleStart` catch `plugin_crashed:` 前缀 → `toCreatorError` 新 kind `plugin_crashed`，展示「插件启动后立即退出」+ stderr 原文（折叠），让用户看到是插件代码问题。
- R4 不破坏正常运行：GUI 插件（PySide6/Tkinter）正常启动弹窗不受影响（wait 超时即放行，不阻塞窗口）。
- R5 不破坏 stop_plugin / scan_plugin_status 的进程表逻辑。
- R6 单测：spawn 秒退 → 返回 plugin_crashed + stderr；spawn 存活 → 返回 pid。
- R7（一键修复）plugin_crashed 错误卡片加「让 AI 修复」按钮：点击 → 把 stderr + 修复指令构造成追问 prompt → 走 PluginCreatorHome 的 send_input 追问路径（--resume 续接），AI 在原会话上下文修复代码、重写文件。
- R8（一键修复边界）会话不可 resume（无 cli_session_id 的 degraded 模式 / 会话已切走关闭）时，「让 AI 修复」按钮禁用或提示「该会话无法续接，请重新描述问题」。

## Acceptance Criteria

- [ ] AI 生成有 bug 的插件（启动即异常）→ 点运行 → 看到「插件启动后立即退出」+ Python 异常原文（如 AttributeError），而非「无法启动」/「运行中」。
- [ ] **错误卡片有「让 AI 修复」按钮**：点击 → 创建器自动以 stderr 为追问内容发起一轮对话 → AI 修复代码 → 用户再运行验证通过。
- [ ] 正常 GUI 插件（PySide6 弹窗）→ 点运行 → 正常显示「运行中」+ 弹窗，不受 stderr 捕获影响。
- [ ] 正常 Node 插件同理。
- [ ] stop_plugin / scan_plugin_status 逻辑不受影响。
- [ ] cargo test -p lingfang-desktop 通过（新增秒退捕获测试）。
- [ ] 前端 typecheck 通过。

## Out of Scope

- 持续监控运行中插件的 stderr（仅捕获启动秒退；运行中崩溃由 scan_plugin_status 的 stopped 态反映，不捕获其 stderr）。
- stdout 展示（PRD 需求 9 明确不嵌入终端输出，保持 null）。
- 插件代码 bug 自动修复（仅展示错误让用户/AI 定位）。

## Notes

- 复杂任务，需 design.md + implement.md。
- 改 plugin_runner.rs（start_plugin stderr + 秒退判定）+ creator-error.ts（plugin_crashed kind）+ ScriptPreviewPanel（catch 前缀）。
- 风险：stderr piped 后若不排空，pipe 满会阻塞进程——正常运行时需后台线程排空或关闭 pipe。
