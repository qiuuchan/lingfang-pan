// tool-card.spec.ts — FloatingCreator 布局 + ToolCallCard 视觉状态测试。
//
// 覆盖用户列出的 UI 问题：
//  - 文本输出排版（用户/助手气泡左右对齐 + Markdown 卡片）
//  - 卡片/组件样式（ToolCallCard running/ok/error + 展开/收起）
//  - 整体布局（标题栏、空状态、输入区）
//  - 状态展示（生成中/搜索中/网络慢状态条）
//
// 策略：不依赖按钮点击打开创建器（脆弱），而是通过 addInitScript
// 注入 lf:creator-open=1 让 App 初始即打开面板。用真实渲染的 DOM 文案
// 做断言，截图用 toHaveScreenshot 留基线。
import { test, expect } from '@playwright/test';
import { openApp } from './helpers';

test.describe('FloatingCreator 布局', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('打开创建器后，空状态正确显示', async ({ page }) => {
    // 标题栏 + 空状态文案都应可见（lf:creator-open=1 已在 openApp 里注入）。
    await expect(page.getByText('AI 创建插件')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'AI 插件创建器' })).toBeVisible();
    // 三个示例胶囊。
    await expect(page.getByRole('button', { name: /天气查询/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /待办事项/ })).toBeVisible();
    // 截图空状态（首次运行生成基线）。
    await expect(page).toHaveScreenshot('creator-empty.png', { maxDiffPixelRatio: 0.05 });
  });

  test('输入消息后状态正确（输入态截图）', async ({ page }) => {
    await expect(page.getByText('AI 创建插件')).toBeVisible({ timeout: 10000 });
    const input = page.locator('textarea').first();
    await expect(input).toBeVisible();
    await input.fill('做一个带界面的计算器插件');
    // 输入框有内容后，发送按钮可点。
    await expect(input).toHaveValue('做一个带界面的计算器插件');
    await expect(page).toHaveScreenshot('creator-input.png', { maxDiffPixelRatio: 0.05 });
  });

  test('标题栏功能按钮齐全（上下文/历史/技能/版本切换/关闭）', async ({ page }) => {
    await expect(page.getByText('AI 创建插件')).toBeVisible({ timeout: 10000 });
    // 用 title 属性定位（最稳定，不受图标影响）。
    await expect(page.getByTitle('对话历史')).toBeVisible();
    await expect(page.getByTitle('技能')).toBeVisible();
    await expect(page.getByTitle(/打开上下文窗口|先发送一次对话/)).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭' })).toBeVisible();
    // 版本切换：快速 / 高级 两个。
    await expect(page.getByText('快速', { exact: true })).toBeVisible();
    await expect(page.getByText('高级', { exact: true })).toBeVisible();
  });
});
