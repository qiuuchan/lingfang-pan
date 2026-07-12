import { expect, test, type Page } from '@playwright/test';
import { mockAuth, mockBackend } from './helpers';
import {
  PACKAGE_ID,
  RELEASE_ID,
  TEAM_ID,
  USER_ID,
  listing,
  managementItem,
  packageSummary,
  pluginPermissions,
  releaseSummary,
} from './plugin-publishing-fixture';

async function setupPluginWorkbench(page: Page) {
  await page.addInitScript(({ publishedPackage, publishedRelease }) => {
    const invoke = async (command: string) => {
      switch (command) {
        case 'list_plugin_installations':
        case 'list_draft_workspaces':
          return [];
        case 'plugin:dialog|open':
          return '/tmp/external-demo.lfplugin';
        case 'inspect_lfplugin_v4':
          return {
            sha256: 'a'.repeat(64),
            sizeBytes: 4096,
            uncompressedSizeBytes: 8192,
            manifest: publishedRelease.manifest,
            files: [
              { path: '_meta.json', sizeBytes: 64 },
              { path: 'manifest.json', sizeBytes: 512 },
              { path: 'ui/index.html', sizeBytes: 1024 },
            ],
          };
        case 'publish_local_artifact':
          return { package: publishedPackage, release: publishedRelease };
        default:
          return null;
      }
    };
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: {
        core: { invoke },
        event: { listen: async () => () => undefined },
      },
    });
  }, { publishedPackage: packageSummary, publishedRelease: releaseSummary });

  await mockAuth(page);
  await mockBackend(page);

  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token: 'test-token',
      onboarding: 'TEAM_SPACE',
      user: {
        id: USER_ID,
        email: 'test@test.com',
        displayName: '测试用户',
        platformRole: 'NONE',
        status: 'ACTIVE',
      },
      team: { id: TEAM_ID, name: '测试团队', slug: 'test-team', role: 'MEMBER' },
      permissions: pluginPermissions,
      application: null,
    }),
  }));
  await page.route('**/api/plugin-registry/manage', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [managementItem] }),
  }));
  await page.route(`**/api/plugin-packages/${PACKAGE_ID}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      package: packageSummary,
      releases: [releaseSummary],
      listing,
      entitled: true,
    }),
  }));

  let submissionAttempts = 0;
  await page.route(`**/api/plugin-releases/${RELEASE_ID}/submit-marketplace`, (route) => {
    submissionAttempts += 1;
    if (submissionAttempts === 1) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'review_unavailable', message: '审核服务暂时不可用' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        release: { ...releaseSummary, marketReviewStatus: 'PENDING' },
      }),
    });
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '草稿', exact: true }).click();
  await expect(page.getByRole('heading', { name: '插件开发' })).toBeVisible();
  return { submissionAttempts: () => submissionAttempts };
}

test('本地制品发布保留团队版本，市场失败只重试提审', async ({ page }) => {
  const attempts = await setupPluginWorkbench(page);

  await page.getByRole('button', { name: '上传本地插件' }).click();
  await page.getByPlaceholder('选择 .lfplugin 文件（开发环境可输入路径）').fill('/tmp/external-demo.lfplugin');
  await page.getByTitle('检查制品').click();

  await expect(page.getByText('外部工具示例插件', { exact: true })).toBeVisible();
  await expect(page.getByText('运行时：client')).toBeVisible();
  await expect(page.getByLabel('来源说明')).toHaveValue('外部开发工具');
  await page.getByLabel('发布目标').selectOption('market');
  await page.getByLabel('市场价格（分）').fill('990');
  await page.evaluate(() => {
    let callbackId = 0;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        transformCallback: () => ++callbackId,
      },
    });
  });
  await page.getByRole('button', { name: '发布并提审' }).click();

  await expect(page.getByText('团队已发布，市场提审失败')).toBeVisible();
  await expect(page.getByText('审核服务暂时不可用')).toBeVisible();
  expect(attempts.submissionAttempts()).toBe(1);

  await page.getByRole('button', { name: '只重试市场提审' }).click();
  await expect(page.getByText('发布完成')).toBeVisible();
  expect(attempts.submissionAttempts()).toBe(2);
});

test('移动视口可查看来源与四轴状态且无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupPluginWorkbench(page);

  expect(await page.evaluate(() => document.querySelector('main')!.getBoundingClientRect().width >= 300)).toBe(true);

  await page.getByRole('tab', { name: '已发布' }).click();
  await expect(page.getByText('外部工具示例插件', { exact: true })).toBeVisible();
  await expect(page.getByText('VS Code 工程')).toBeVisible();
  await expect(page.getByText('桌面端')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByText('外部工具示例插件', { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Package 启用中')).toBeVisible();
  await expect(page.getByText('未提审')).toBeVisible();
  await expect(page.getByRole('button', { name: '提交市场' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
