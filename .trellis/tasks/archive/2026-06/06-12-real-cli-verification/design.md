# 真实 CLI 验证技术设计

## Scope

本任务负责最终真实反馈和证据归档。它不允许用 mock 替代真实 CLI。

## Evidence Document

Create:

- `docs/plugin-workbench-real-cli-test.md`

Required sections:

- Environment
- Backend / tenant / team setup
- Claude Code result
- Codex result
- OpenCode result
- Cloud upload results
- Team sharing results
- Marketplace review results
- Plugin run results
- Process cleanup results
- Failures and blockers

## Real CLI Matrix

| Tool        | Binary   | Version  | Auth ready | Model    | Probe    | Generate | Upload   | Run      | Cleanup  |
| ----------- | -------- | -------- | ---------- | -------- | -------- | -------- | -------- | -------- | -------- |
| Claude Code | required | required | required   | required | required | required | required | required | required |
| Codex       | required | required | required   | required | required | required | required | required | required |
| OpenCode    | required | required | required   | required | required | required | required | required | required |

## Result Policy

- `pass`: real CLI invocation completed and evidence recorded.
- `fail`: real CLI invocation ran and failed; stdout/stderr recorded.
- `blocked`: CLI missing, not authenticated, model unavailable, backend unavailable, or user action required.

The whole parent task can only be reported complete if all three tools are `pass`.

## Required Evidence Per Tool

- binary path
- version output
- model
- exact command or app action
- session id
- transcript path
- stdout/stderr tail
- generated plugin id or failure reason
- cloud upload plugin id
- cleanup result

## No-Go Conditions

- No fake adapter.
- No fixture-only output.
- No help-only verification.
- No “assumed pass”.
- No skipping unavailable tools in final completion report.

## Integration Evidence

Also verify:

- Team member sees uploaded plugin.
- Public marketplace submission creates pending review.
- Admin approval makes plugin public.
- Rejection reason returns to author when rejected.
- Platform/db plugin cannot invoke local CLI capability.
