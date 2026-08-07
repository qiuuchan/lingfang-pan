import { expect, test, type Page } from '@playwright/test';

const ids = {
  cloud: '11111111-1111-4111-8111-111111111111',
  client: '22222222-2222-4222-8222-222222222222',
  desktop: '33333333-3333-4333-8333-333333333333',
  listing: '44444444-4444-4444-8444-444444444444',
  release: '55555555-5555-4555-8555-555555555555',
};
const priceVersion = `pv1.${'a'.repeat(43)}`;
function card(
  id: string,
  name: string,
  runtime_type: 'cloud' | 'client' | 'nodejs',
  preview_mode: 'CLOUD_TRIAL' | 'CLIENT_SANDBOX' | 'STATIC_DESKTOP',
  price = 0
) {
  return {
    package_id: id,
    listing_id: ids.listing,
    release_id: ids.release,
    name,
    summary: `${name} 简介`,
    author_display_name: '作者',
    category: 'MEDIA',
    runtime_type,
    quality_tier: 'LISTED',
    version: '1.0.0',
    install_count: 2,
    rating_count: 1,
    average_rating_tenths: 45,
    base_price_cents: price,
    effective_price_cents: price,
    price_version: priceVersion,
    preview_mode,
    updated_at: '2026-07-16T00:00:00.000Z',
  };
}
const cards = [
  card(ids.cloud, '云端图片', 'cloud', 'CLOUD_TRIAL', 990),
  card(ids.client, '浏览器画板', 'client', 'CLIENT_SANDBOX'),
  card(ids.desktop, '本地脚本', 'nodejs', 'STATIC_DESKTOP'),
];
function detail(id: string) {
  const base = cards.find((x) => x.package_id === id)!;
  return {
    ...base,
    release_sha256: 'b'.repeat(64),
    readme_markdown: `# ${base.name}\n\n安全插件详情`,
    compatibility: {
      runtime_type: base.runtime_type,
      desktop_platforms: [],
      minimum_desktop_version: null,
      web_compatible: base.preview_mode !== 'STATIC_DESKTOP',
    },
    preview_actions:
      base.preview_mode === 'CLOUD_TRIAL'
        ? [
            {
              action_id: 'image.generate',
              name: '生成图片',
              description: '',
              action_contract_version: '1.0.0',
              action_surface_sha256: 'c'.repeat(64),
              input_schema: {
                type: 'object',
                properties: { prompt: { type: 'string' } },
                required: ['prompt'],
                additionalProperties: false,
              },
            },
          ]
        : [],
  };
}

async function mockApi(page: Page) {
  let loggedIn = false;
  let team = { id: 'team-1', name: '设计团队' };
  let csrf = '';
  await page.route('**/api/web/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers,
        body: JSON.stringify(body),
      });
    if (path === '/api/web/session/csrf') {
      csrf = 'csrf-browser';
      return json({ csrfToken: csrf }, 200, {
        'set-cookie': 'lf_web_session=session-1; HttpOnly; SameSite=Lax; Path=/',
      });
    }
    if (path === '/api/web/session/login') {
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      loggedIn = true;
      return json({ user: { email: 'user@example.com', displayName: '测试用户' }, team });
    }
    if (path === '/api/web/session/team') {
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      team = { id: 'team-2', name: '视频团队' };
      return json({ user: { email: 'user@example.com', displayName: '测试用户' }, team });
    }
    if (path === '/api/web/session')
      return json(
        loggedIn ? { user: { email: 'user@example.com', displayName: '测试用户' }, team } : {}
      );
    if (path === '/api/web/session/teams')
      return json({
        teams: [
          { id: 'team-1', name: '设计团队' },
          { id: 'team-2', name: '视频团队' },
        ],
      });
    if (path === '/api/web/plugins')
      return json({ items: cards, total: 3, page: 1, page_size: 24 });
    if (path === '/api/web/plugins/discovery/home')
      return json({
        policy: {
          version: 1,
          listing_age_days: 14,
          current_release_activation_age_days: 7,
          active_teams_30d: 20,
          observed_runs_30d: 50,
          max_failure_rate_bps: 200,
          rating_teams: 10,
          min_average_rating_tenths: 43,
          matured_paid_orders_90d: 10,
          max_refund_rate_bps: 500,
          security_lookback_days: 90,
        },
        generated_at: '2026-07-16T00:00:00.000Z',
        category: null,
        featured: [],
        category_popular: [],
        recent_quality: [],
      });
    if (/^\/api\/web\/plugins\/[^/]+$/.test(path)) return json(detail(path.split('/').at(-1)!));
    if (path.endsWith('/purchase')) {
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      return json({ entitled: true, purchase_id: 'purchase-1' });
    }
    if (path === '/api/web/plugins/orders/current')
      return json({
        items: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            package_id: ids.cloud,
            package_name: '云端图片',
            release_id: ids.release,
            release_version: '1.0.0',
            currency_code: 'CNY',
            list_price_cents: 990,
            discount_cents: 0,
            price_cents: 990,
            platform_fee_bps: 2000,
            platform_cents: 198,
            seller_cents: 792,
            settlement_version: 'SETTLEMENT_V2',
            price_version: priceVersion,
            campaign_id: null,
            attribution_kind: 'ORGANIC',
            status: 'PENDING_SETTLEMENT',
            created_at: '2026-07-16T00:00:00.000Z',
            settle_at: '2026-07-23T00:00:00.000Z',
            refundable_until: '2026-07-23T00:00:00.000Z',
            settled_at: null,
            refunded_at: null,
            refund_request: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    if (path.includes('/plugin-actions/') && path.endsWith('/preview'))
      return json({ code: 'web_preview_quota_exceeded', message: '今日次数已用完' }, 429);
    if (path.includes('/plugin-preview/') && path.endsWith('/sessions'))
      return json({
        session_id: 'session-1',
        channel_nonce: 'nonce-1',
        package_id: ids.client,
        release_id: ids.release,
        release_sha256: 'b'.repeat(64),
        mode: 'CLIENT_SANDBOX',
        expires_at: '2099-01-01T00:00:00.000Z',
      });
    return json({ code: 'not_found', message: path }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});
test('catalog search/filter and details', async ({ page }) => {
  await page.goto('/plugins');
  await expect(page.getByRole('heading', { name: '插件中心' })).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(3);
  await page.getByLabel('搜索插件').fill('画板');
  await expect(page.locator('.card')).toHaveCount(1);
  await page.getByLabel('搜索插件').fill('');
  await page.getByLabel('运行时筛选').selectOption('cloud');
  await expect(page.locator('.card')).toHaveCount(1);
  await page.getByRole('link', { name: /云端图片/ }).click();
  await expect(page.locator('header').getByRole('heading', { name: '云端图片' })).toBeVisible();
  await expect(page.getByText('安全插件详情')).toBeVisible();
});
test('cookie login, CSRF team switch, paid purchase and orders', async ({ page, context }) => {
  await page.goto(`/plugins/${ids.cloud}`);
  await page.getByLabel('邮箱').fill('user@example.com');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('测试用户')).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === 'lf_web_session' && c.httpOnly)).toBeTruthy();
  await page.getByLabel('当前团队').selectOption('team-2');
  await expect(page.getByLabel('当前团队')).toHaveValue('team-2');
  await page.getByRole('button', { name: /购买/ }).click();
  await expect(page.getByText('购买成功，可在桌面端下载')).toBeVisible();
  await page.goto('/orders');
  await expect(page.getByText('云端图片')).toBeVisible();
  await expect(page.getByText(/待结算/)).toBeVisible();
});
test('client/cloud/static preview routing and quota error', async ({ page }) => {
  await page.goto(`/plugins/${ids.cloud}/preview`);
  await expect(page.locator('[data-mode="CLOUD_TRIAL"]')).toBeVisible();
  await page.getByLabel('JSON 输入').fill('{"prompt":"日落"}');
  await page.getByRole('button', { name: '开始真实试跑' }).click();
  await expect(page.getByRole('alert')).toContainText('今日次数已用完');
  await page.goto(`/plugins/${ids.client}/preview`);
  await expect(page.locator('[data-mode="CLIENT_SANDBOX"]')).toBeVisible();
  await page.goto(`/plugins/${ids.desktop}/preview`);
  await expect(page.locator('[data-mode="STATIC_DESKTOP"]')).toBeVisible();
  await expect(page.getByText('仅支持桌面运行')).toBeVisible();
});
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
])
  test(`no horizontal overflow ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const path of [
      '/plugins',
      `/plugins/${ids.cloud}`,
      `/plugins/${ids.cloud}/preview`,
      '/orders',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        ),
        path
      ).toBeTruthy();
    }
  });
