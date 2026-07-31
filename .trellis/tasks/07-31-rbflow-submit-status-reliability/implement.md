# Implement — 子任务 C：提交/状态链路可靠性

## 结论：本任务无后端/桥/relay 代码改动（research-only）

研究确认链路异步且超时对齐，根因是插件 120s 读超时（见 `design.md` + `research/submit-status-blocking.md`）。

## 可执行修复（在 E 实现，此处登记以便 E 验收）
- [ ] （E）`plugins/rbflow-video/main.py` `bridge_submit_video` 读超时 → 600s。
- [ ] （E）`SubmitWorker` / `VoiceSubmitWorker`：提交超时/网络错 → 不标 FAILED，显示"提交未确认，可能已在后台运行，请刷新"。
- [ ] （E）拿到 task_id 即"已入队"；重进按 task_id 拉真实阶段。

## C 自身步骤
1. ✓ research/submit-status-blocking.md（已完成）。
2. ✓ design.md 结论（已完成）。
3. 无 commit（无 diff）。C 由 E 兑现验收。
