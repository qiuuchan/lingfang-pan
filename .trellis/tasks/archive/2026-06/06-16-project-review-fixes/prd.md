# Project review fixes

## Goal

修复上轮全代码审查确认的项目级问题，使项目重新达到可构建、可测试、关键安全边界可解释的状态。

## Requirements

- 恢复 `apps/collab-api` 的依赖解析、Prisma Client 生成链路、TypeScript 类型检查和测试执行。
- 修复首次安装向导只允许初始化一次的并发风险。
- 修复认证验证码绕过不能依赖可伪造的普通请求头。
- 修复平台设置批量保存的半更新风险。
- 统一 Gitee token 与其他敏感配置的保存、审计脱敏、二次确认查看行为。
- 清理桌面端 Rust 测试中的不可达代码 warning 和进程 kill 权限噪声。
- 保持现有 API 语义尽量兼容；确需收紧行为时，以安全默认优先。

## Acceptance Criteria

- [ ] `pnpm -r typecheck` 通过。
- [ ] `pnpm -r test` 通过。
- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 通过，且不再出现本次定位的不可达代码 warning / `kill: Operation not permitted` 噪声。
- [ ] 首次安装向导重复或并发初始化只能成功一次，其余请求返回已初始化语义。
- [ ] 启用验证码场景下，伪造 `X-Client: desktop` 不再能跳过验证码。
- [ ] 平台设置批量保存同批写入和审计具备事务一致性；失败不产生半更新状态。
- [ ] `giteeAccessToken` 与 `smtpPass`、`geetestCaptchaKey` 的敏感配置处理策略一致。

## Out of Scope

- 不重构认证体系为完整设备注册系统。
- 不引入 Redis、队列或新基础设施。
- 不改动产品 UI 大结构。
- 不处理上轮审查之外的新功能需求。

## Notes

- 本任务来自全代码审查结果，优先修复阻断与安全边界问题。
- 若依赖安装或 Prisma generate 暴露新的环境问题，先修复生成链路，不绕过类型检查。
