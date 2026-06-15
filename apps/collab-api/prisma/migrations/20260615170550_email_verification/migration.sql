-- 新增 User.emailVerified 字段：null=未验证，注册时自动发验证邮件。
-- 默认 null（现有用户视为未验证）；首版不阻断登录，session 响应带 emailVerified 供前端提示。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" TIMESTAMP(3);
