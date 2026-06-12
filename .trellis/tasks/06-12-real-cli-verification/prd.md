# 真实 CLI 验证

## Goal

建立不可跳过的真实 CLI 手测门禁，逐项验证 Claude Code、Codex、OpenCode 通过本机真实 CLI 完成插件创建、云端上传、团队共享、市场提交和进程清理，并记录真实反馈证据。

## Requirements

- 创建 `docs/plugin-workbench-real-cli-test.md` 或同等验证记录。
- 测试必须直接调用真实 Claude Code、Codex、OpenCode CLI。
- 不接受 mock、fake adapter、静态 fixture 或只跑 `--help`。
- 每个 CLI 都必须完成发现、版本检查、最小响应、生成插件、云端上传、运行/预览、停止/清理。
- 任一 CLI 未安装、未登录、模型不可用或调用失败时，必须记录真实失败，并阻塞完成结论。
- 验证记录必须包含命令、版本、模型、session id、transcript 路径、cloud plugin id、审核状态、失败日志或截图路径。

## Acceptance Criteria

- [ ] 真实 CLI 测试文档存在。
- [ ] Claude Code 真实最小响应通过并记录输出。
- [ ] Codex 真实最小响应通过并记录输出。
- [ ] OpenCode 真实最小响应通过并记录输出。
- [ ] 三个工具都真实生成插件草稿并记录 transcript。
- [ ] 三个工具生成的插件都上传云端团队共享。
- [ ] 团队成员可见/可运行被实际验证。
- [ ] 公共市场提交审核被实际验证。
- [ ] 审核通过或驳回被实际验证。
- [ ] 进程停止和注册表清理被实际验证。
- [ ] 所有失败项均包含真实 stdout/stderr/错误截图或日志路径。

## Out Of Scope

- 不用模拟器替代真实 CLI。
- 不以自动类型检查替代真实手测。
