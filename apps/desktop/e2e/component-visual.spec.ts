// component-visual.spec.ts — 组件级视觉测试（ToolCallCard + TodoPanel）。
//
// 通过 e2e-harness/index.html 白板页直接渲染组件的多种状态变体，
// 绕开 relay SSE / 登录态的脆弱 mock，直接断言组件的 DOM 结构 + 截图。
// 覆盖用户关心的「卡片/组件样式错」「状态展示差」。
import { test, expect } from '@playwright/test';

const HARNESS = '/e2e-harness/index.html';

test.describe('ToolCallCard 组件状态', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS);
    await page.waitForLoadState('networkidle');
  });

  test('running 态显示 spinner + Running 标签', async ({ page }) => {
    const card = page
      .locator('text=WebSearch')
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")]')
      .first();
    await expect(card).toBeVisible();
    // 状态徽标是 Running。
    await expect(card.getByText('Running')).toBeVisible();
    // spinner 存在（animate-spin 的 Loader2）。
    await expect(card.locator('.animate-spin')).toBeVisible();
  });

  test('ok 态显示对勾 + Done 标签 + 文件路径摘要', async ({ page }) => {
    const card = page
      .locator('text=Read')
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")]')
      .first();
    await expect(card).toBeVisible();
    await expect(card.getByText('Done')).toBeVisible();
    // 摘要显示文件路径。
    await expect(card.getByText('plugin/main.py')).toBeVisible();
  });

  test('error 态显示叉号 + Failed 标签 + 红色样式', async ({ page }) => {
    const card = page
      .locator('text=Edit')
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")]')
      .first();
    await expect(card).toBeVisible();
    await expect(card.getByText('Failed')).toBeVisible();
    // error 徽标含 text-destructive 类（红色）。徽标是唯一同时含 Failed 文本 + 状态色的 span。
    const badge = card
      .locator('span', { hasText: 'Failed' })
      .filter({ hasText: /Failed/ })
      .last();
    await expect(badge).toHaveClass(/text-destructive/);
  });

  test('点击卡片展开 Input/Output 面板', async ({ page }) => {
    const card = page
      .locator('text=Read')
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")]')
      .first();
    // 初始收起：无 Input/Output 标签。
    await expect(card.getByText('Input')).toHaveCount(0);
    // 点击展开。
    await card.getByRole('button').click();
    await expect(card.getByText('Input')).toBeVisible();
    await expect(card.getByText('Output')).toBeVisible();
    // Output 区显示文件路径 + 内容（JSON pretty 后含 plugin/main.py）。
    await expect(card.getByText(/plugin\/main\.py/).last()).toBeVisible();
  });

  test('再点击收起面板', async ({ page }) => {
    const card = page
      .locator('text=Read')
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")]')
      .first();
    await card.getByRole('button').click();
    await expect(card.getByText('Input')).toBeVisible();
    await card.getByRole('button').click();
    await expect(card.getByText('Input')).toHaveCount(0);
  });

  test('TodoWrite 摘要显示完成数', async ({ page }) => {
    const card = page
      .locator('text=Todo')
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")]')
      .first();
    await expect(card).toBeVisible();
    // 3 项 todo 里 1 完成（初始化插件 completed）。
    await expect(card.getByText('1/3 完成')).toBeVisible();
  });

  test('三态卡片整组截图', async ({ page }) => {
    const section = page
      .locator('h2:has-text("三种状态")')
      .locator('xpath=following-sibling::div[1]');
    await expect(section).toHaveScreenshot('toolcard-states.png', { maxDiffPixelRatio: 0.05 });
  });
});

test.describe('TodoPanel 组件', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS);
    await page.waitForLoadState('networkidle');
  });

  // 辅助：定位第 N 个 TodoPanel 容器（harness 挂了「进行中」「已完成」两个）。
  // 新样式用 rounded-xl + 底部折叠抽屉风格。
  const panelAt = (page: import('@playwright/test').Page, idx: number) =>
    page
      .locator('text=任务清单')
      .locator('xpath=ancestor::div[contains(@class,"rounded-xl")]')
      .nth(idx);

  test('折叠态显示标题 + 完成数 + 百分比', async ({ page }) => {
    const panel = panelAt(page, 0);
    await expect(panel).toBeVisible();
    // 折叠条显示 1/4 和 25%。
    await expect(panel.getByText('1/4')).toBeVisible();
    await expect(panel.getByText('25%')).toBeVisible();
  });

  test('点击展开后显示任务明细 + 进度条', async ({ page }) => {
    const panel = panelAt(page, 0);
    // 折叠态：明细不可见。
    await expect(panel.getByText('初始化插件目录')).toHaveCount(0);
    // 点击折叠条展开。
    await panel.getByRole('button').click();
    // 四项任务内容都在。
    await expect(panel.getByText('初始化插件目录')).toBeVisible();
    await expect(panel.getByText('编写核心逻辑')).toBeVisible();
    await expect(panel.getByText('添加图形界面')).toBeVisible();
    await expect(panel.getByText('编写说明文档')).toBeVisible();
  });

  test('优先级标签颜色正确（高=红/中=橙/低=蓝）', async ({ page }) => {
    const panel = panelAt(page, 0);
    await panel.getByRole('button').click(); // 展开
    const tags = panel.locator('span', { hasText: /^(高|中|低)$/ });
    // 高 → red, 中 → amber, 低 → sky（Tailwind 类）。
    await expect(tags.nth(0)).toHaveClass(/red/); // 初始化（高）
    await expect(tags.nth(1)).toHaveClass(/red/); // 核心逻辑（高）
    await expect(tags.nth(2)).toHaveClass(/amber/); // 界面（中）
    await expect(tags.nth(3)).toHaveClass(/sky/); // 文档（低）
  });

  test('进行中任务高亮背景', async ({ page }) => {
    const panel = panelAt(page, 0);
    await panel.getByRole('button').click(); // 展开
    const item = panel.locator('li', { hasText: '编写核心逻辑' });
    await expect(item).toHaveClass(/bg-primary/);
  });

  test('已完成任务有删除线', async ({ page }) => {
    const panel = panelAt(page, 0);
    await panel.getByRole('button').click(); // 展开
    const item = panel.locator('li', { hasText: '初始化插件目录' });
    await expect(item.getByText('初始化插件目录')).toHaveClass(/line-through/);
  });

  test('全部完成时显示绿色徽标', async ({ page }) => {
    // 第二个 TodoPanel（已完成态）：4/4 = 100%。
    const donePanel = panelAt(page, 1);
    await expect(donePanel.getByText('100%')).toBeVisible();
    await expect(donePanel.getByText('4/4')).toBeVisible();
    // 徽标变绿（含 green 类）。
    const badge = donePanel.locator('span', { hasText: '100%' }).filter({ hasText: '100%' }).last();
    await expect(badge).toHaveClass(/green/);
  });

  test('折叠态面板截图', async ({ page }) => {
    const section = page
      .locator('h2:has-text("进行中")')
      .locator('xpath=following-sibling::div[1]');
    await expect(section).toHaveScreenshot('todo-panel-collapsed.png', { maxDiffPixelRatio: 0.05 });
  });

  test('展开态面板截图', async ({ page }) => {
    const panel = panelAt(page, 0);
    await panel.getByRole('button').click(); // 展开
    const section = page
      .locator('h2:has-text("进行中")')
      .locator('xpath=following-sibling::div[1]');
    await expect(section).toHaveScreenshot('todo-panel-expanded.png', { maxDiffPixelRatio: 0.05 });
  });
});
