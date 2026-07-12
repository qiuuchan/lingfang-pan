import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXTURE_IDS,
  FIXTURE_NAMES,
  GovernanceApiMock,
} from './governance-api-mock';

const packagePath = (packageId: string) => `/api/admin/plugin-packages/${packageId}`;
const releasesPath = (packageId: string) => `${packagePath(packageId)}/releases`;
const releasePath = (releaseId: string) => `/api/admin/plugin-releases/${releaseId}`;

async function boot(page: Page, options: ConstructorParameters<typeof GovernanceApiMock>[0] = {}) {
  const api = new GovernanceApiMock(options);
  await api.install(page);
  await page.addInitScript(() => {
    localStorage.setItem('lf:collab-admin:token', 'playwright-token');
    localStorage.setItem('lf:admin-onboarding-done', '2026-07-12T08:00:00.000Z');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '仪表盘' })).toBeVisible();
  return api;
}

async function enterPluginGovernance(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 1024) {
    await page.getByRole('button', { name: '打开导航菜单' }).click();
  }
  await page
    .getByRole('navigation', { name: '管理导航' })
    .getByRole('button', { name: '治理中心', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: '治理中心' })).toBeVisible();
  await expect(page.getByRole('button', {
    name: `查看插件包详情：${FIXTURE_NAMES.currentPackage}`,
  })).toBeVisible();
}

async function openPackage(page: Page, name: string) {
  await page.getByRole('button', { name: `查看插件包详情：${name}` }).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function selectRelease(page: Page, dialog: Locator, version: string) {
  await dialog.getByRole('combobox', { name: '选择发行版' }).click();
  await page.getByRole('option', { name: new RegExp(`^v${version.replace('.', '\\.')}`) }).click();
}

async function assertNoViewportOverflow(page: Page, dialog?: Locator) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);

  if (dialog) {
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      if (!box) return Number.POSITIVE_INFINITY;
      return Math.max(-box.x, box.x + box.width - overflow.viewport);
    }).toBeLessThanOrEqual(1);
  }
}

test.describe('插件发行治理', () => {
  test('首屏只请求 package page，详情与子分区按需加载并在 Sheet 会话内缓存', async ({ page }) => {
    const api = await boot(page);
    await enterPluginGovernance(page);
    await page.waitForTimeout(100);

    expect(new Set(api.pluginRequests().map((request) => (
      `${request.method} ${request.pathname}${request.search}`
    )))).toEqual(new Set(['GET /api/admin/plugin-packages?page=1&pageSize=10']));

    const dialog = await openPackage(page, FIXTURE_NAMES.currentPackage);
    await expect(dialog.getByText('Cursor 导入')).toBeVisible();
    await expect.poll(() => api.count('GET', packagePath(FIXTURE_IDS.currentPackage))).toBe(1);
    await expect.poll(() => api.count('GET', releasesPath(FIXTURE_IDS.currentPackage))).toBe(1);
    await expect.poll(() => api.count('GET', releasePath(FIXTURE_IDS.currentRelease))).toBe(1);
    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/manifest`)).toBe(0);
    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/files`)).toBe(0);
    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/reviews`)).toBe(0);

    await dialog.getByRole('tab', { name: 'Manifest', exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('"id": "fixture.external-workflow"');
    await dialog.getByRole('tab', { name: '文件', exact: true }).click();
    await expect(dialog.getByText('dist/index.js')).toBeVisible();
    await dialog.getByRole('tab', { name: '审核记录', exact: true }).click();
    await expect(dialog.getByText('来源校验完成')).toBeVisible();

    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/manifest`)).toBe(1);
    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/files`)).toBe(1);
    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/reviews`)).toBe(1);

    await dialog.getByRole('tab', { name: 'Manifest', exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('fixture.external-workflow');
    await dialog.getByRole('tab', { name: '文件', exact: true }).click();
    await expect(dialog.getByText('dist/index.js')).toBeVisible();
    await dialog.getByRole('tab', { name: '审核记录', exact: true }).click();
    await expect(dialog.getByText('来源校验完成')).toBeVisible();
    await page.waitForTimeout(100);

    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/manifest`)).toBe(1);
    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/files`)).toBe(1);
    expect(api.count('GET', `${releasePath(FIXTURE_IDS.currentRelease)}/reviews`)).toBe(1);
  });

  test('只对精确市场当前版调用 release delist 端点', async ({ page }) => {
    const api = await boot(page);
    await enterPluginGovernance(page);
    const dialog = await openPackage(page, FIXTURE_NAMES.currentPackage);

    await expect(dialog.getByRole('button', { name: '平台下架当前版' })).toBeVisible();
    await selectRelease(page, dialog, '0.9.0');
    await expect.poll(() => api.count('GET', releasePath(FIXTURE_IDS.historicalRelease))).toBe(1);
    await expect(dialog.getByRole('button', { name: '平台下架当前版' })).toHaveCount(0);

    await selectRelease(page, dialog, '1.0.0');
    await expect(dialog.getByRole('button', { name: '平台下架当前版' })).toBeVisible();
    await dialog.getByRole('button', { name: '平台下架当前版' }).click();
    const confirmation = page.getByRole('dialog', { name: '平台下架市场当前发行版' });
    await confirmation.getByRole('textbox', { name: '治理操作原因' }).fill('测试精确当前版下架');
    await confirmation.getByRole('button', { name: '确认下架' }).click();

    const endpoint = `${releasePath(FIXTURE_IDS.currentRelease)}/delist`;
    await expect.poll(() => api.count('POST', endpoint)).toBe(1);
    expect(api.last('POST', endpoint)?.body).toEqual({ reason: '测试精确当前版下架' });
    expect(api.pluginRequests().filter((request) => (
      request.method === 'POST' && request.pathname.endsWith('/delist')
    )).map((request) => request.pathname)).toEqual([endpoint]);
    await expect(confirmation).toBeHidden();
    await expect(dialog.getByRole('button', { name: '恢复市场上架' })).toBeVisible();
  });

  test('只有 PLATFORM 下架记录允许按 package 恢复', async ({ page }) => {
    const api = await boot(page);
    await enterPluginGovernance(page);

    const ownerDialog = await openPackage(page, FIXTURE_NAMES.ownerDelistedPackage);
    await expect.poll(() => api.count('GET', releasePath(FIXTURE_IDS.ownerDelistedRelease))).toBe(1);
    await expect(ownerDialog.getByRole('button', { name: '恢复市场上架' })).toHaveCount(0);
    await ownerDialog.getByRole('button', { name: '关闭' }).click();
    await expect(ownerDialog).toBeHidden();

    const platformDialog = await openPackage(page, FIXTURE_NAMES.platformDelistedPackage);
    await expect(platformDialog.getByRole('button', { name: '恢复市场上架' })).toBeVisible();
    await platformDialog.getByRole('button', { name: '恢复市场上架' }).click();
    const confirmation = page.getByRole('dialog', { name: '恢复市场上架' });
    await confirmation.getByRole('textbox', { name: '治理操作原因' }).fill('平台复核完成');
    await confirmation.getByRole('button', { name: '确认恢复' }).click();

    const endpoint = `${packagePath(FIXTURE_IDS.platformDelistedPackage)}/relist`;
    await expect.poll(() => api.count('POST', endpoint)).toBe(1);
    expect(api.last('POST', endpoint)?.body).toEqual({ reason: '平台复核完成' });
    expect(api.count('POST', `${packagePath(FIXTURE_IDS.ownerDelistedPackage)}/relist`)).toBe(0);
  });

  test('409 冲突只刷新可变详情、当前列表与当前审核记录', async ({ page }) => {
    const api = await boot(page, { delistConflictOnce: true });
    await enterPluginGovernance(page);
    const dialog = await openPackage(page, FIXTURE_NAMES.currentPackage);
    await expect(dialog.getByRole('button', { name: '平台下架当前版' })).toBeVisible();

    await dialog.getByRole('tab', { name: 'Manifest', exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('fixture.external-workflow');
    await dialog.getByRole('tab', { name: '文件', exact: true }).click();
    await expect(dialog.getByText('dist/index.js')).toBeVisible();
    await dialog.getByRole('tab', { name: '审核记录', exact: true }).click();
    await expect(dialog.getByText('来源校验完成')).toBeVisible();

    const paths = {
      list: '/api/admin/plugin-packages',
      detail: packagePath(FIXTURE_IDS.currentPackage),
      releases: releasesPath(FIXTURE_IDS.currentPackage),
      core: releasePath(FIXTURE_IDS.currentRelease),
      manifest: `${releasePath(FIXTURE_IDS.currentRelease)}/manifest`,
      files: `${releasePath(FIXTURE_IDS.currentRelease)}/files`,
      reviews: `${releasePath(FIXTURE_IDS.currentRelease)}/reviews`,
    };
    const baseline = Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [key, api.count('GET', path)]),
    ) as Record<keyof typeof paths, number>;

    await dialog.getByRole('button', { name: '平台下架当前版' }).click();
    const confirmation = page.getByRole('dialog', { name: '平台下架市场当前发行版' });
    await confirmation.getByRole('textbox', { name: '治理操作原因' }).fill('制造并发冲突');
    await confirmation.getByRole('button', { name: '确认下架' }).click();

    await expect(page.getByText('发行版状态已变化').first()).toBeVisible();
    for (const key of ['list', 'detail', 'releases', 'core', 'reviews'] as const) {
      await expect.poll(() => api.count('GET', paths[key])).toBe(baseline[key] + 1);
    }
    await page.waitForTimeout(100);
    expect(api.count('GET', paths.manifest)).toBe(baseline.manifest);
    expect(api.count('GET', paths.files)).toBe(baseline.files);
    await expect(confirmation).toBeVisible();
  });

  for (const viewport of [
    { width: 1440, height: 900, label: 'desktop' },
    { width: 390, height: 844, label: 'mobile' },
  ]) {
    test(`${viewport.label} ${viewport.width}x${viewport.height} 列表与详情无页面级横向溢出`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const api = await boot(page);
      await enterPluginGovernance(page);
      await assertNoViewportOverflow(page);

      const dialog = await openPackage(page, FIXTURE_NAMES.currentPackage);
      await expect.poll(() => api.count('GET', releasePath(FIXTURE_IDS.currentRelease))).toBe(1);
      await assertNoViewportOverflow(page, dialog);
      if (process.env.CAPTURE_GOVERNANCE_SCREENSHOTS === '1') {
        await page.screenshot({
          path: testInfo.outputPath(`plugin-governance-${viewport.label}.png`),
          fullPage: true,
        });
        await dialog.getByRole('button', { name: '平台下架当前版' }).click();
        await expect(page.getByRole('dialog', { name: '平台下架市场当前发行版' })).toBeVisible();
        await page.waitForTimeout(160);
        await page.screenshot({
          path: testInfo.outputPath(`plugin-governance-${viewport.label}-confirmation.png`),
          fullPage: true,
        });
      }
    });
  }
});
