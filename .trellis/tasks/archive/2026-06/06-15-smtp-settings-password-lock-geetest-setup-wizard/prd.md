# SMTP后台设置+密码重试锁定+极验验证码+首次启动向导

## Goal

4 项安全/引导完善：SMTP 后台可配置（不重启）+ 密码重试锁定（防暴力）+ 极验 V4 验证码（登录/注册）+ 首次启动安装向导（DB 无管理员时）。

## 范围

### 1. SMTP 后台设置（admin settings 页配置，运行时生效）
- SMTP 配置（smtpUrl/smtpFrom/smtpUser/smtpPass）从 .env 改为**后台 PlatformSetting 表存储**，admin settings 页可编辑。
- mail.service 运行时读 PlatformSetting（缓存），不重启即生效。
- .env 的 SMTP_URL 作为**初始化 fallback**（首次启动无后台配置时用 env）。
- admin settings 页已有 SMTP 展示区（组A 之前加），补编辑表单 + 保存。

### 2. 密码重试锁定（防暴力破解）
- 登录失败 N 次（默认 5）锁定账户 15 分钟。
- 实现：
  - User 加 `failedLoginAttempts Int @default(0)` + `lockedUntil DateTime?` 字段（迁移）。
  - login 端点：失败时 failedLoginAttempts++，达阈值设 lockedUntil=now+15min；成功时重置。
  - login 前检查 lockedUntil（未过锁定期 → 拒绝 + 返剩余时间）。
  - 可配置阈值/锁定期（PlatformSetting：maxLoginAttempts/lockDurationMinutes）。
  - 区别于 throttler（throttler 按 IP 限流，这个按账户锁定）。

### 3. 极验 V4 验证码（登录/注册/找回密码）
- 后端：
  - PlatformSetting 存 geetestCaptchaId + geetestCaptchaKey（admin 配置）。
  - 新 geetest.service.ts：validate(lot_number, captcha_output, pass_token, gen_time) → 调 `http://gcaptcha4.geetest.com/validate`（HMAC-SHA256(captchaKey, lot_number) 签名）。异常容灾（极验挂了不阻断，降级放行 + 日志）。
  - 登录/注册/找回密码端点：入参加可选 captcha 参数（geetestCaptchaId 配置了才强制校验，未配置跳过——开发态不强制）。
- 前端：
  - 桌面 Auth + admin LoginPage：集成极验前端 SDK（gt4.js 或 npm 包）。
  - geetestCaptchaId 从 GET /api/platform-info 拿（公开）。
  - 验证通过后把 4 参数随登录/注册请求带给后端。

### 4. 首次启动安装向导
- 后端：
  - GET /api/setup/status（@Public）：返 `{ needsSetup: boolean }`（DB 有无 PLATFORM_ADMIN）。
  - POST /api/setup（@Public，仅 needsSetup=true 时可用，否则 403）：入参 { email, password, displayName, platformName }。
    - 创建第一个 PLATFORM_ADMIN + 平台名存 PlatformSetting。
    - 完成后该端点自动失效（再调返 403 setup_already_done）。
    - 审计 platform_admin.bootstrap。
- 前端（admin + 桌面）：
  - 启动时调 /api/setup/status，needsSetup=true 弹安装向导（设管理员邮箱/密码/平台名）。
  - 完成后登录。

## Constraints

- 简体中文。UTF-8 无 BOM。
- 极验 captchaKey 加密存 PlatformSetting（敏感，复用 LLM_KEY_ENCRYPTION_KEY 加密）或明文存（首版明文，标注 TODO 加密）。
- 极验容灾：极验 API 超时/异常不阻断主流程（降级放行 + 日志），避免外部依赖挂导致无法登录。
- 密码锁定不锁死（锁定期过后自动解锁，或 admin 可手动解锁）。
- setup 端点严格仅未初始化时可用（防被恶意创建管理员）。

## AC

- [ ] AC1 admin settings 可编辑 SMTP 配置，保存后 mail.service 运行时读新配置（不重启）。
- [ ] AC2 登录失败 5 次锁 15 分钟，锁定期拒绝登录返剩余时间，成功重置计数。
- [ ] AC3 极验配置后，登录/注册需过验证码；未配置跳过（开发态）。
- [ ] AC4 极验容灾（API 异常降级放行不阻断）。
- [ ] AC5 首次启动（无 PLATFORM_ADMIN）setup 端点可用，完成后失效。
- [ ] AC6 前端弹安装向导（设管理员/平台名）。
- [ ] AC7 全量验证绿。
