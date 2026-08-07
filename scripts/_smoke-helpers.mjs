// 冒烟脚本共享工具：幂等地确保「演示团队(demo) + demo-user」存在于运行中的 collab-api。
// 设计目标：让 verify-all.mjs 在「全新 db:setup 后的数据库」也能直接跑通，无需手动前置。
// 全程走公共 API（不直连库），故在任意能访问 API 的环境都可复用。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const API = process.env.API_BASE || 'http://localhost:19006';
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'ChangeMe123!';
export const DEMO_SLUG = 'demo';
export const DEMO_EMAIL = 'demo-user@lingfang.dev';
export const DEMO_PASSWORD = 'DemoUser123!';

export const auth = (t) => ({ authorization: `Bearer ${t}` });
export const jsonH = (t) => ({ 'content-type': 'application/json', ...auth(t) });

export async function jreq(r) {
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: r.status, json, text };
}

export async function login(email, password, path = '/api/auth/login') {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.text();
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`login ${email} failed ${r.status}: ${body.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  const j = JSON.parse(body);
  return { token: j.token, email: j.user?.email, teamId: j.teamId, userId: j.user?.id ?? j.id };
}

export async function adminLogin() {
  return (await login(ADMIN_EMAIL, ADMIN_PASSWORD, '/api/auth/admin/login')).token;
}

// 幂等确保 demo 团队 + demo-user（团队管理员）。返回 { teamId, demoToken }。
export async function ensureDemoTenant(adminToken) {
  // 1) 查找是否已有 demo 团队
  let teamId = null;
  const list = await jreq(await fetch(`${API}/api/admin/teams`, { headers: auth(adminToken) }));
  if (list.status < 300) {
    const data = list.json;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    const found = items.find((t) => t.slug === DEMO_SLUG);
    if (found) teamId = found.id;
  }
  // 2) 没有则创建
  if (!teamId) {
    const created = await jreq(
      await fetch(`${API}/api/admin/teams`, {
        method: 'POST',
        headers: jsonH(adminToken),
        body: JSON.stringify({ name: '演示团队', slug: DEMO_SLUG, balanceCents: 50000 }),
      })
    );
    if (created.status >= 300) {
      throw new Error(
        `createDemoTeam failed ${created.status}: ${JSON.stringify(created.json || created.text).slice(0, 200)}`
      );
    }
    teamId = created.json?.id ?? created.json?.team?.id;
    console.log(`   [ensure] 已创建演示团队 teamId=${teamId}`);
  } else {
    console.log(`   [ensure] 复用已有演示团队 teamId=${teamId}`);
  }

  // 3) 确保 demo-user 存在且为团队管理员
  let demoToken;
  try {
    demoToken = (await login(DEMO_EMAIL, DEMO_PASSWORD)).token;
  } catch {
    // 用户不存在 → 注册并任命
    const reg = await jreq(
      await fetch(`${API}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: DEMO_EMAIL,
          password: DEMO_PASSWORD,
          displayName: '演示用户',
        }),
      })
    );
    if (reg.status >= 300) {
      throw new Error(
        `registerDemoUser failed ${reg.status}: ${JSON.stringify(reg.json || reg.text).slice(0, 200)}`
      );
    }
    const userId = reg.json?.user?.id ?? reg.json?.id;
    const appoint = await jreq(
      await fetch(`${API}/api/admin/teams/${teamId}/admins`, {
        method: 'POST',
        headers: jsonH(adminToken),
        body: JSON.stringify({ userId }),
      })
    );
    if (appoint.status >= 300) {
      throw new Error(
        `appointDemoAdmin failed ${appoint.status}: ${JSON.stringify(appoint.json || appoint.text).slice(0, 200)}`
      );
    }
    demoToken = (await login(DEMO_EMAIL, DEMO_PASSWORD)).token;
    console.log(`   [ensure] 已注册并任命 demo-user (userId=${userId})`);
  }
  return { teamId, demoToken };
}

// 将市场结算 writerMode 切到 SETTLEMENT_V2（幂等）。购买真实扣灵石的前提。
// 走 Prisma 直连库（无对应管理端 API）。无 DATABASE_URL 时跳过（假定库已就绪）。
export function enableSettlementV2() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const collabApi = resolve(root, 'apps/collab-api');
  const r = spawnSync(process.execPath, ['../../scripts/enable-settlement-v2.mjs'], {
    cwd: collabApi,
    env: process.env,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.warn(
      '   [warn] enable-settlement-v2 未成功（可能缺少 DATABASE_URL），若库已是 SETTLEMENT_V2 可忽略'
    );
  }
}
