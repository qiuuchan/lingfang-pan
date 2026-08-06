// 轻量健康检查：验证 LingFang 后端 API 核心域是否真实可用。
// 用法： node scripts/smoke.mjs   （需先启动 collab-api，见 scripts/dev-up.sh）
const API = process.env.API_BASE || 'http://localhost:19006';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASS = process.env.ADMIN_PASS || 'ChangeMe123!';

async function main() {
  let ok = true;

  // 1) 平台管理员登录（管理端通道）
  let r = await fetch(API + '/api/auth/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  console.log('[admin/login]', r.status);
  if (r.status < 200 || r.status >= 300) { ok = false; console.log('   body=', (await r.text()).slice(0, 200)); return; }
  const token = (await r.json()).token;
  const auth = { Authorization: `Bearer ${token}` };

  // 2) 当前会话
  r = await fetch(API + '/api/auth/me', { headers: auth });
  console.log('[auth/me]', r.status, r.status === 200 ? 'OK' : 'FAIL'); if (r.status !== 200) ok = false;

  // 3) 管理端：团队列表（验证 PLATFORM_ADMIN RBAC）
  r = await fetch(API + '/api/admin/teams?page=1&pageSize=5', { headers: auth });
  console.log('[admin/teams]', r.status); if (r.status !== 200) ok = false;

  // 4) 管理端：仪表盘聚合
  r = await fetch(API + '/api/admin/dashboard', { headers: auth });
  console.log('[admin/dashboard]', r.status, r.status === 200 ? (await r.text()).slice(0, 80) : 'FAIL'); if (r.status !== 200) ok = false;

  // 5) 公开端点
  r = await fetch(API + '/api/platform-info');
  console.log('[platform-info]', r.status); if (r.status !== 200) ok = false;

  console.log(ok ? '\nSMOKE: PASS ✅' : '\nSMOKE: FAIL ❌');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
