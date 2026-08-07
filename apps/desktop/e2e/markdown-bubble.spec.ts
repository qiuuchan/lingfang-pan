// markdown-bubble.spec.ts — Markdown 排版 + 对话气泡布局测试。
//
// 覆盖用户关心的「文本输出排版乱」「整体布局问题」：
//  - Markdown 代码块/表格/列表/引用的渲染正确性
//  - 用户/助手气泡的左右对齐
//  - 思考块（reasoning details）的折叠样式
import { test, expect } from '@playwright/test';

const HARNESS = '/e2e-harness/index.html';

test.describe('Markdown 渲染', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS);
    await page.waitForLoadState('networkidle');
  });

  test('标题/粗体/斜体/行内代码正确渲染', async ({ page }) => {
    const section = page
      .locator('h2:has-text("Markdown 排版")')
      .locator('xpath=following-sibling::div[1]');
    await expect(section.getByRole('heading', { name: '标题' })).toBeVisible();
    await expect(section.locator('strong', { hasText: '粗体' })).toBeVisible();
    await expect(section.locator('em', { hasText: '斜体' })).toBeVisible();
    await expect(section.locator('code', { hasText: '行内代码' })).toBeVisible();
  });

  test('无序列表渲染为 ul + 3 项', async ({ page }) => {
    const section = page
      .locator('h2:has-text("Markdown 排版")')
      .locator('xpath=following-sibling::div[1]');
    const ul = section.locator('ul').first();
    await expect(ul).toBeVisible();
    await expect(ul.locator('li')).toHaveCount(3);
  });

  test('有序列表渲染为 ol + 2 项', async ({ page }) => {
    const section = page
      .locator('h2:has-text("Markdown 排版")')
      .locator('xpath=following-sibling::div[1]');
    const ol = section.locator('ol').first();
    await expect(ol).toBeVisible();
    await expect(ol.locator('li')).toHaveCount(2);
  });

  test('表格正确渲染（2 列 3 行）', async ({ page }) => {
    const section = page
      .locator('h2:has-text("Markdown 排版")')
      .locator('xpath=following-sibling::div[1]');
    const table = section.locator('table').first();
    await expect(table).toBeVisible();
    // 表头 1 行 + 数据 2 行 = 3 行。
    await expect(table.locator('tr')).toHaveCount(3);
    await expect(table.getByText('天气查询')).toBeVisible();
  });

  test('代码块渲染为 pre + 高亮', async ({ page }) => {
    const section = page
      .locator('h2:has-text("Markdown 排版")')
      .locator('xpath=following-sibling::div[1]');
    const codeBlock = section.locator('pre').first();
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock.getByText(/def hello/)).toBeVisible();
    await expect(codeBlock.getByText(/print/)).toBeVisible();
  });

  test('引用块渲染为 blockquote', async ({ page }) => {
    const section = page
      .locator('h2:has-text("Markdown 排版")')
      .locator('xpath=following-sibling::div[1]');
    const quote = section.locator('blockquote').first();
    await expect(quote).toBeVisible();
    await expect(quote.getByText('这是一段引用文字')).toBeVisible();
  });

  test('Markdown 整体截图', async ({ page }) => {
    const section = page
      .locator('h2:has-text("Markdown 排版")')
      .locator('xpath=following-sibling::div[1]');
    await expect(section).toHaveScreenshot('markdown-render.png', { maxDiffPixelRatio: 0.05 });
  });
});

test.describe('对话气泡布局', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS);
    await page.waitForLoadState('networkidle');
  });

  test('用户气泡右对齐 + 主色背景', async ({ page }) => {
    // 用户气泡：含 justify-end 的外层 + from-primary 的气泡。
    const wrapper = page
      .locator('div.justify-end')
      .filter({ hasText: '做一个带界面的天气查询插件' });
    await expect(wrapper).toBeVisible();
    const bubble = wrapper.locator('div').filter({ hasText: '做一个带界面的天气查询插件' }).first();
    const cls = await bubble.evaluate((el) => el.className);
    // 气泡含主色渐变背景类。
    expect(cls).toContain('from-primary');
  });

  test('助手气泡左对齐 + 卡片背景', async ({ page }) => {
    const wrapper = page.locator('div.justify-start').filter({ hasText: '好的！我来帮你创建一个' });
    await expect(wrapper).toBeVisible();
    // 助手气泡含卡片背景类（bg-card/70，Tailwind 透明度变体）。
    const bubble = wrapper.getByText('好的！我来帮你创建一个').first();
    const cls = await bubble.evaluate((el) => {
      // 向上找最近的有 bg-card 的祖先。
      let node = el as Element | null;
      while (node && !/\bbg-card\b/.test(node.className)) node = node.parentElement;
      return node ? node.className : '';
    });
    expect(cls).toContain('bg-card');
  });

  test('用户气泡在助手气泡之前（时序正确）', async ({ page }) => {
    const user = page.getByText('做一个带界面的天气查询插件');
    const assistant = page.getByText('好的！我来帮你创建一个');
    // 用户气泡的 boundingBox 顶部 Y 应小于助手气泡（在上方）。
    const userBox = await user.boundingBox();
    const assistantBox = await assistant.boundingBox();
    expect(userBox && assistantBox).toBeTruthy();
    expect(userBox!.y).toBeLessThan(assistantBox!.y);
  });

  test('对话气泡整体截图', async ({ page }) => {
    const section = page
      .locator('h2:has-text("对话气泡")')
      .locator('xpath=following-sibling::div[1]');
    await expect(section).toHaveScreenshot('chat-bubbles.png', { maxDiffPixelRatio: 0.05 });
  });
});

test.describe('思考块（reasoning）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS);
    await page.waitForLoadState('networkidle');
  });

  test('默认展开 + 显示 Thinking 标题', async ({ page }) => {
    const details = page.locator('summary:has-text("Thinking")').locator('xpath=ancestor::details');
    await expect(details).toBeVisible();
    await expect(details).toHaveAttribute('open', '');
    await expect(details.getByText(/用户想要一个天气查询插件/)).toBeVisible();
  });

  test('思考块截图', async ({ page }) => {
    const section = page
      .locator('h2:has-text("思考块")')
      .locator('xpath=following-sibling::div[1]');
    await expect(section).toHaveScreenshot('reasoning-block.png', { maxDiffPixelRatio: 0.05 });
  });
});
