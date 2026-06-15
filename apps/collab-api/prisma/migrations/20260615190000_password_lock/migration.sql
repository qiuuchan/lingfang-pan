-- 组B 账户级密码重试锁定：User 加 failedLoginAttempts + lockedUntil。
--
-- 目标与依据：
--   throttler 仅做 IP 级限流（10/min），无法防「分布式 IP 池定向爆破单账户」。
--   本字段实现账户级锁定：连续密码错误达阈值（PlatformSetting.maxLoginAttempts，默认 5）后
--   置 lockedUntil=now+lockDuration（PlatformSetting.lockDurationMinutes，默认 15min），
--   login 入口校验未过期的 lockedUntil 直接拒绝。与 throttler 正交，两层叠加。
--
-- 非破坏式 ALTER：两列均带默认值（failedLoginAttempts=0 / lockedUntil=null），
-- 现有用户全部回填为「未锁定」状态，不影响既有数据与在途登录。

-- 连续密码错误累计计数：达阈值后触发锁定（阈值/锁定期由 PlatformSetting 可配）。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;

-- 账户锁定截止时间：null=未锁定；非 null 且 > now 时 login 直接拒绝。
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
