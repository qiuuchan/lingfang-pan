-- 新增 User.tokenVersion 字段：禁用/降级用户时自增，使已签发的旧 JWT 失效（ADMIN-02/AUTH-01/XERR-02）。
-- 默认 0，现有用户全部为 0；旧 JWT payload 无 tokenVersion 字段，JwtAuthGuard 用
-- `payload.tokenVersion !== undefined` 守卫兼容旧 token（旧 token 仅过 status 校验）。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
