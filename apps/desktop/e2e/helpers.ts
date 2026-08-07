// e2e/helpers.ts — UI 测试通用工具：mock 登录态 + 拦截后端请求。
//
// 桌面端无 URL 路由，CreatorWorkspace 等界面在登录态后才能到达。
// 用 addInitScript 注入 localStorage session 绕过登录门，
// 再用 route 拦截所有 /api/ 请求返回 mock 数据，避免 BackendUnreachable。

const MOCK_USER_ID = 'test-user';
const MOCK_TENANT_ID = 'test-team';

export interface CreatorWorkspaceFixture {
  conversations: Array<Record<string, unknown>>;
  selectedConversationId?: string;
}

/** 注入伪造的登录态（绕过 !session.token 门 + onboarding 门）。 */
export async function mockAuth(
  page: import('@playwright/test').Page,
  creatorFixture?: CreatorWorkspaceFixture
) {
  await page.addInitScript(
    ({ fixture, tenantId, userId }) => {
      // 伪造 session：token 非空即过登录门；onboarding 设为 TEAM_SPACE 跳过新手引导。
      localStorage.setItem(
        'lf:session',
        JSON.stringify({
          token: 'test-token',
          userId,
          displayName: '测试用户',
          email: 'test@test.com',
          tenantId,
          tenantName: '测试团队',
          role: 'MEMBER',
          onboarding: 'TEAM_SPACE',
          isPlatformAdmin: false,
          permissions: [],
        })
      );
      localStorage.setItem('lf:backendUrl', 'http://localhost:1420');
      localStorage.setItem('lf:authToken', 'test-token');
      localStorage.setItem('lf:sidebar-open', '1');

      if (fixture) {
        localStorage.setItem(
          `lf:creator-conversations:${tenantId}`,
          JSON.stringify(fixture.conversations)
        );
        if (fixture.selectedConversationId) {
          localStorage.setItem(`lf:creator-selected:${tenantId}`, fixture.selectedConversationId);
        }
      }
    },
    {
      fixture: creatorFixture ?? null,
      tenantId: MOCK_TENANT_ID,
      userId: MOCK_USER_ID,
    }
  );
}

/** 拦截所有后端 API 请求，返回 mock 空数据（避免 BackendUnreachable 遮罩）。 */
export async function mockBackend(page: import('@playwright/test').Page) {
  // auth/me：返回有效 session，保持登录态。
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'test-token',
        onboarding: 'TEAM_SPACE',
        user: {
          id: MOCK_USER_ID,
          email: 'test@test.com',
          displayName: '测试用户',
          platformRole: 'NONE',
          status: 'ACTIVE',
        },
        team: {
          id: MOCK_TENANT_ID,
          name: '测试团队',
          slug: 'test-team',
          role: 'MEMBER',
        },
        permissions: [],
        application: null,
      }),
    })
  );
  // setup/status：不需要初始化。
  await page.route('**/api/setup/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ needsSetup: false }),
    })
  );
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
export async function openApp(
  page: import('@playwright/test').Page,
  creatorFixture?: CreatorWorkspaceFixture
) {
  await mockAuth(page, creatorFixture);
  await mockBackend(page);
  await page.goto('/');
  // 等待主界面加载（Home 页的问候语或侧栏出现）。
  await page.waitForLoadState('networkidle');
}

/** 从当前登录态主页按真实产品路径进入开发插件 Agent 工作区。 */
export async function enterCreatorWorkspace(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'AI 创建插件', exact: true }).click();
  await page
    .getByRole('button', { name: /创建器侧边栏/ })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

/** 打开已登录且已进入顶层创建器 Dialog 的 CreatorWorkspace。 */
export async function openCreatorWorkspace(
  page: import('@playwright/test').Page,
  creatorFixture?: CreatorWorkspaceFixture
) {
  await openApp(page, creatorFixture);
  await enterCreatorWorkspace(page);
}
