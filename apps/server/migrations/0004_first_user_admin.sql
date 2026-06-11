-- 权限组：首个注册用户即平台管理员（SQLite 方言）。
-- 存量回填——若当前没有任何平台管理员，则把最早注册的用户标记为管理员。
-- 新注册流程在 register 内对「表中第一个用户」直接置位，二者互补且幂等。

UPDATE users SET is_platform_admin = 1
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_admin = 1);
