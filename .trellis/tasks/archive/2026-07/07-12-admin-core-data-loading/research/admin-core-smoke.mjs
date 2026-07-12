import { chromium } from '@playwright/test';

const appUrl = 'http://127.0.0.1:19007';
const apiOrigin = 'http://localhost:19006';
const requests = [];

const user = {
  id: 'user-1',
  email: 'user@example.com',
  displayName: '示例用户',
  status: 'ACTIVE',
  platformRole: 'NONE',
  platformRoleId: null,
  emailVerified: true,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-10T08:00:00.000Z',
};
const admin = {
  ...user,
  id: 'admin-1',
  email: 'admin@example.com',
  displayName: '平台管理员',
  platformRole: 'PLATFORM_ADMIN',
  platformRoleId: 'role-platform-admin',
};
const secondUser = {
  ...user,
  id: 'user-2',
  email: 'second@example.com',
  displayName: '第二位用户',
};
const team = {
  id: 'team-1',
  name: '产品团队',
  slug: 'product-team',
  status: 'ACTIVE',
  balanceCents: 128000,
  defaultPoolId: null,
  memberCount: 2,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-07-10T08:00:00.000Z',
};
const secondTeam = {
  ...team,
  id: 'team-2',
  name: '设计团队',
  slug: 'design-team',
  memberCount: 1,
};
const platformRole = {
  id: 'role-platform-1',
  name: '运营专员',
  code: 'operator',
  scope: 'PLATFORM',
  teamId: null,
  isSystem: false,
  description: '负责平台内容运营',
  permissionCount: 1,
  memberCount: 3,
  createdAt: '2026-06-01T08:00:00.000Z',
  updatedAt: '2026-07-10T08:00:00.000Z',
};
const teamRole = {
  ...platformRole,
  id: 'role-team-1',
  name: '团队管理员',
  code: 'team_admin',
  scope: 'TEAM',
  teamId: team.id,
  isSystem: true,
  memberCount: 1,
};
const permission = {
  code: 'platform.user.list',
  label: '查看用户',
  scope: 'PLATFORM',
  group: 'user',
  moduleKey: 'user',
  moduleLabel: '用户',
  moduleOrder: 1,
  description: '查看用户列表',
  createdAt: '2026-06-01T08:00:00.000Z',
};

function page(items, pageSize = 10) {
  return { items, total: items.length, page: 1, pageSize };
}

function responseFor(url, method) {
  const { pathname, searchParams } = new URL(url);
  if (method !== 'GET') return { ok: true };
  if (pathname === '/api/setup/status') return { needsSetup: false };
  if (pathname === '/api/platform-info') return { platformName: 'LingFang', logoUrl: '' };
  if (pathname === '/api/auth/me') return { user: admin, onboarding: 'done' };
  if (pathname === '/api/admin/dashboard') {
    return { users: 2, teams: 1, pendingApplications: 0, enabledPlugins: 1, disabledPlugins: 0, pendingPluginReviews: 0 };
  }
  if (pathname === '/api/admin/stats/generation') {
    return { period: 'current_month', month: { calls: 0, success: 0, failed: 0, successRate: 0 }, total: { calls: 0, success: 0, failed: 0, successRate: 0 }, avgDurationMs: null };
  }
  if (pathname === '/api/admin/stats/finance') {
    return { period: 'current_month', month: { gmvCents: 0 }, total: { gmvCents: 0 }, platformRevenueCents: 0, paidUserCount: 0, totalUserCount: 2, conversionRate: 0, topPlugins: [] };
  }
  if (pathname === '/api/admin/users') {
    return page(searchParams.get('platformRole') === 'PLATFORM_ADMIN' ? [admin] : [user, secondUser]);
  }
  if (pathname === '/api/admin/users/options') return page([user], 20);
  if (pathname === `/api/admin/users/${user.id}/detail`) return { user };
  if (pathname === `/api/admin/users/${secondUser.id}/detail`) return { user: secondUser };
  if (pathname === `/api/admin/users/${admin.id}/detail`) return { user: admin };
  if (pathname === `/api/admin/users/${user.id}/teams`) {
    return page([{ teamId: team.id, userId: user.id, role: 'MEMBER', status: 'ACTIVE', teamRoleId: null, joinedAt: '2026-06-02T08:00:00.000Z', team }]);
  }
  if (pathname === `/api/admin/users/${user.id}/wallet`) {
    return { ...page([{ id: 'wallet-1', amountCents: 3000, direction: 'CREDIT', reason: '测试入账', pluginId: null, createdAt: '2026-07-01T08:00:00.000Z' }]), balanceCents: 5500 };
  }
  if (pathname === `/api/admin/users/${user.id}/logins`) {
    return page([{ id: 'login-1', action: 'auth.login.success', createdAt: '2026-07-10T08:00:00.000Z' }]);
  }
  if (pathname === `/api/admin/admins/${admin.id}/activity`) {
    return page([{ id: 'audit-1', action: 'admin.user.updated', targetType: 'User', targetId: user.id, createdAt: '2026-07-10T08:00:00.000Z' }]);
  }
  if (pathname === '/api/admin/teams') return page([team, secondTeam]);
  if (pathname === `/api/admin/teams/${team.id}/detail`) {
    return { team: { ...team, allowPublicJoin: false, description: '团队详情' }, memberCount: 2, roleCount: 1, pluginCount: 1, purchaseCount: 1, ledgerSummary: { totalCreditCents: 128000, totalDebitCents: 0, netCents: 128000 } };
  }
  if (pathname === `/api/admin/teams/${secondTeam.id}/detail`) {
    return { team: { ...secondTeam, allowPublicJoin: false, description: '' }, memberCount: 1, roleCount: 0, pluginCount: 0, purchaseCount: 0, ledgerSummary: { totalCreditCents: 128000, totalDebitCents: 0, netCents: 128000 } };
  }
  if (pathname === `/api/admin/teams/${team.id}/members`) {
    return page([{ teamId: team.id, userId: user.id, role: 'MEMBER', status: 'ACTIVE', teamRoleId: teamRole.id, joinedAt: '2026-06-02T08:00:00.000Z', user, teamRole: { id: teamRole.id, name: teamRole.name, code: teamRole.code } }]);
  }
  if (pathname === `/api/admin/teams/${team.id}/roles`) return page([teamRole]);
  if (pathname === `/api/admin/teams/${team.id}/roles/permissions`) return { permissions: [{ ...permission, scope: 'TEAM', code: 'team.member.list' }] };
  if (pathname === `/api/admin/teams/${team.id}/roles/${teamRole.id}`) return { role: { ...teamRole, permissions: ['team.member.list'] } };
  if (pathname === `/api/admin/teams/${team.id}/plugins`) {
    return page([{ id: 'plugin-1', name: '周报助手', status: 'ENABLED', visibility: 'TEAM', reviewStatus: 'APPROVED', marketplace: false, priceCents: 0, installCount: 5, createdAt: '2026-06-01T08:00:00.000Z', updatedAt: '2026-07-01T08:00:00.000Z' }]);
  }
  if (pathname === `/api/admin/teams/${team.id}/purchases`) {
    return page([{ id: 'purchase-1', pluginId: 'plugin-1', packageId: null, pluginName: '周报助手', priceCents: 1200, buyerUserId: user.id, sellerUserId: admin.id, createdAt: '2026-07-01T08:00:00.000Z' }]);
  }
  if (pathname === `/api/admin/teams/${team.id}/ledger`) {
    return { ...page([{ id: 'ledger-1', teamId: team.id, amountCents: 128000, direction: 'CREDIT', reason: '初始余额', actorUserId: admin.id, createdAt: '2026-06-01T08:00:00.000Z', actor: admin }]), summary: { totalCreditCents: 128000, totalDebitCents: 0, netCents: 128000 } };
  }
  if (pathname === '/api/admin/roles') return page([platformRole]);
  if (pathname === '/api/admin/roles/permissions') return { permissions: [permission] };
  if (pathname === `/api/admin/roles/${platformRole.id}`) return { role: { ...platformRole, permissions: [permission.code] } };
  if (pathname === '/api/admin/permission-groups') return { groups: [] };
  return page([]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function count(pathFragment) {
  return requests.filter((url) => url.includes(pathFragment)).length;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('lf:collab-admin:token', 'smoke-token');
  localStorage.setItem('lf:admin-onboarding-done', new Date().toISOString());
});
await context.route(`${apiOrigin}/**`, async (route) => {
  const request = route.request();
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    return;
  }
  requests.push(request.url());
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(responseFor(request.url(), request.method())),
  });
});

const pageHandle = await context.newPage();
await pageHandle.goto(appUrl);
await pageHandle.getByRole('heading', { name: '仪表盘' }).waitFor();

let start = requests.length;
await pageHandle.getByRole('button', { name: '用户管理' }).click();
await pageHandle.getByText(user.email, { exact: false }).last().waitFor();
let phase = requests.slice(start);
assert(phase.some((url) => url.includes('/api/admin/users?page=1&pageSize=10&platformRole=NONE')), '用户页未请求服务端分页列表');
assert(!phase.some((url) => url.includes(`/users/${user.id}/`)), '用户页首屏提前请求了详情数据');

await pageHandle.getByRole('button', { name: `查看用户详情：${user.email}` }).click();
await pageHandle.getByText('邮箱验证').waitFor();
assert(count(`/users/${user.id}/detail`) === 1, '用户详情请求次数异常');
assert(count(`/users/${user.id}/teams`) === 0, '用户团队 Tab 未打开却发生请求');
await pageHandle.getByRole('tab', { name: '团队' }).click();
await pageHandle.getByText(team.name, { exact: true }).waitFor();
await pageHandle.getByRole('tab', { name: '钱包' }).click();
await pageHandle.getByText('钱包余额').waitFor();
await pageHandle.getByRole('tab', { name: '团队' }).click();
assert(count(`/users/${user.id}/teams`) === 1, '用户团队 Tab 返回后重复请求，未在 Sheet 会话内缓存');
const secondUserStart = requests.length;
await pageHandle.locator(`button[aria-label="查看用户详情：${secondUser.email}"]`).evaluate((button) => button.click());
await pageHandle.getByRole('dialog').getByText(secondUser.email, { exact: true }).waitFor();
const secondUserRequests = requests.slice(secondUserStart);
assert(secondUserRequests.some((url) => url.includes(`/users/${secondUser.id}/detail`)), '快速切换用户后未请求新 overview');
assert(!secondUserRequests.some((url) => url.includes(`/users/${secondUser.id}/teams`) || url.includes(`/users/${secondUser.id}/wallet`) || url.includes(`/users/${secondUser.id}/logins`)), '新用户继承旧 visited Tabs 并提前请求子资源');

await pageHandle.getByRole('button', { name: '关闭' }).click();
start = requests.length;
await pageHandle.getByRole('button', { name: '团队管理' }).click();
await pageHandle.getByRole('button', { name: `查看团队详情：${team.name}` }).waitFor();
phase = requests.slice(start);
assert(phase.some((url) => url.includes('/api/admin/teams?page=1&pageSize=10')), '团队页未请求服务端分页列表');
assert(!phase.some((url) => url.includes(`/teams/${team.id}/`)), '团队页首屏提前请求了详情或用户候选');

await pageHandle.getByRole('button', { name: `查看团队详情：${team.name}` }).click();
await pageHandle.getByText('累计入账').waitFor();
assert(count(`/teams/${team.id}/detail`) === 1, '团队概览详情请求次数异常');
assert(count(`/teams/${team.id}/plugins`) === 0, '插件 Tab 未打开却发生请求');
await pageHandle.getByRole('tab', { name: '插件' }).click();
await pageHandle.getByText('周报助手').waitFor();
assert(count(`/teams/${team.id}/plugins`) === 1, '插件 Tab 未按需请求一次');
await pageHandle.getByRole('tab', { name: '成员' }).click();
await pageHandle.getByText(user.email, { exact: false }).last().waitFor();
assert(count('/api/admin/users/options') === 0, '指定管理员弹窗未打开却请求了用户候选');
await pageHandle.getByRole('button', { name: '指定管理员' }).click();
await pageHandle.getByRole('dialog').getByText('指定团队管理员').waitFor();
assert(count('/api/admin/users/options') === 1, '指定管理员弹窗打开后未请求用户候选');
await pageHandle.getByRole('button', { name: '取消' }).click();
const secondTeamStart = requests.length;
await pageHandle.locator(`button[aria-label="查看团队详情：${secondTeam.name}"]`).evaluate((button) => button.click());
await pageHandle.getByRole('dialog').getByText(secondTeam.slug, { exact: true }).waitFor();
const secondTeamRequests = requests.slice(secondTeamStart);
assert(secondTeamRequests.some((url) => url.includes(`/teams/${secondTeam.id}/detail`)), '快速切换团队后未请求新 overview');
assert(!secondTeamRequests.some((url) => url.includes(`/teams/${secondTeam.id}/members`) || url.includes(`/teams/${secondTeam.id}/roles`) || url.includes(`/teams/${secondTeam.id}/plugins`) || url.includes(`/teams/${secondTeam.id}/purchases`) || url.includes(`/teams/${secondTeam.id}/ledger`)), '新团队继承旧 visited Tabs 并提前请求子资源');

await pageHandle.getByRole('button', { name: '关闭' }).click();
start = requests.length;
await pageHandle.getByRole('button', { name: '角色管理' }).click();
await pageHandle.getByText(platformRole.code, { exact: true }).waitFor();
phase = requests.slice(start);
assert(phase.some((url) => url.includes('/api/admin/roles?page=1&pageSize=10')), '角色页未请求服务端分页列表');
assert(!phase.some((url) => new URL(url).searchParams.has('scope')), '平台角色固定路由不应发送未白名单 scope 参数');
assert(!phase.some((url) => url.includes('/roles/permissions') || url.includes('/permission-groups')), '角色页首屏提前请求了权限字典');
await pageHandle.getByRole('button', { name: `查看角色详情：${platformRole.name}` }).click();
await pageHandle.getByText(permission.code, { exact: true }).waitFor();
assert(count('/api/admin/roles/permissions') === 0, '查看角色详情时提前请求了权限注册表');
await pageHandle.getByRole('button', { name: '编辑角色' }).click();
await pageHandle.getByText('权限分配', { exact: true }).waitFor();
await pageHandle.waitForTimeout(600);
assert(count('/api/admin/roles/permissions') === 1, '角色编辑器未按需请求权限注册表');
assert(count('/api/admin/permission-groups') === 1, '角色编辑器未按需请求权限分组');
const visibleDialog = pageHandle.getByRole('dialog').last();
const hasHiddenAncestor = await visibleDialog.evaluate((element) => {
  let current = element.parentElement;
  while (current) {
    if (current.getAttribute('aria-hidden') === 'true') return true;
    current = current.parentElement;
  }
  return false;
});
assert(!hasHiddenAncestor, '嵌套角色编辑器存在 aria-hidden 祖先');

await pageHandle.screenshot({
  path: '.trellis/tasks/07-12-admin-core-data-loading/research/admin-core-desktop.png',
  fullPage: true,
});

const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(appUrl);
await mobile.getByRole('heading', { name: '仪表盘' }).waitFor();
await mobile.getByRole('button', { name: '打开导航菜单' }).click();
await mobile.getByRole('button', { name: '团队管理' }).click();
await mobile.getByRole('button', { name: `查看团队详情：${team.name}` }).waitFor();
await mobile.waitForTimeout(300);
await mobile.screenshot({
  path: '.trellis/tasks/07-12-admin-core-data-loading/research/admin-core-mobile-list.png',
  fullPage: true,
});
await mobile.getByRole('button', { name: `查看团队详情：${team.name}` }).click();
await mobile.getByText('累计入账').waitFor();
await mobile.waitForTimeout(600);
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 1, `移动端出现 ${overflow}px 页面横向溢出`);
await mobile.screenshot({
  path: '.trellis/tasks/07-12-admin-core-data-loading/research/admin-core-mobile.png',
  fullPage: true,
});

await browser.close();
console.log(JSON.stringify({ ok: true, requestCount: requests.length, overflow }, null, 2));
