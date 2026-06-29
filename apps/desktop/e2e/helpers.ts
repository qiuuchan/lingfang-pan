// e2e/helpers.ts — UI 测试通用工具：mock 登录态 + 拦截后端请求。
//
// 桌面端无 URL 路由，FloatingCreator 等界面在登录态后才能到达。
// 用 addInitScript 注入 localStorage session 绕过登录门，
// 再用 route 拦截所有 /api/ 请求返回 mock 数据，避免 BackendUnreachable。

/** 注入伪造的登录态（绕过 !session.token 门 + onboarding 门）。 */
export async function mockAuth(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    // 伪造 session：token 非空即过登录门；onboarding 设为 TEAM_SPACE 跳过新手引导。
    localStorage.setItem('lf:session', JSON.stringify({
      token: 'test-token',
      tenantId: null,
      onboarding: 'TEAM_SPACE',
      isPlatformAdmin: false,
      displayName: '测试用户',
      role: null,
      permissions: [],
    }));
    localStorage.setItem('lf:backendUrl', 'http://localhost:1420');
    localStorage.setItem('lf:authToken', 'test-token');
    // 默认打开创建器面板（App.tsx 从 lf:creator-open 读取初始 state）。
    localStorage.setItem('lf:creator-open', '1');
  });
}

/** 拦截所有后端 API 请求，返回 mock 空数据（避免 BackendUnreachable 遮罩）。 */
export async function mockBackend(page: import('@playwright/test').Page) {
  // auth/me：返回有效 session，保持登录态。
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token: 'test-token', onboarding: 'TEAM_SPACE',
      user: { id: 'test', email: 'test@test.com', displayName: '测试用户' },
      team: { id: 'test-team', name: '测试团队' },
      permissions: [],
    }),
  }));
  // setup/status：不需要初始化。
  await page.route('**/api/setup/status', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ needsSetup: false }),
  }));
  // 其它 /api/ 请求：返回空数组/空对象，不报错。
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    // 已路由的跳过。
    if (url.includes('/api/auth/me') || url.includes('/api/setup/status')) return route.fallback();
    // 根据 path 返回合理的空值。
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** 打开已登录的主页（注入 auth + mock 后端 + 导航）。 */
export async function openApp(page: import('@playwright/test').Page) {
  await mockAuth(page);
  await mockBackend(page);
  await page.goto('/');
  // 等待主界面加载（Home 页的问候语或侧栏出现）。
  await page.waitForLoadState('networkidle');
}
