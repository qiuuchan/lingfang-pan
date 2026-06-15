# Gitee更新日志接入+密钥配置

## Goal

任务3：后端新增GiteeChangelogService+GET /api/changelog(@Public,独立ChangelogEntry DTO,Bearer鉴权,singleflight缓存10min,容灾降级)+管理端密钥配置(owner/repo/accessToken脱敏+testGitee探测)+审计脱敏修复(SECRET_KEYS含smtpPass/geetestCaptchaKey/giteeAccessToken)+前端ChangelogPage改用listChangelog+renderNotes升级markdown解析+降级横幅

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
