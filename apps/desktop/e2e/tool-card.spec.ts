// tool-card.spec.ts — develop-plugins 页面式 CreatorWorkspace 验收。
//
// 通过真实的“插件”→“开发插件”入口进入工作区，覆盖空状态、紧凑 composer、
// 单一上下文详情入口，以及从 localStorage 恢复会话与插件草稿 Inspector。
import { test, expect } from '@playwright/test';
import {
  enterCreatorWorkspace,
  openCreatorWorkspace,
  type CreatorWorkspaceFixture,
} from './helpers';

const persistedManifest = {
  id: 'persisted-calculator',
  name: '持久化计算器',
  version: '0.1.0',
  description: '从历史会话恢复的计算器插件',
  runtime_type: 'client',
  entry: 'ui/index.html',
  visibility: 'tenant',
  capabilities: [
    { kind: 'ui.view', reason: '展示计算器界面', risk: 'low', requires_admin: false },
  ],
};

const persistedCreatorFixture: CreatorWorkspaceFixture = {
  selectedConversationId: 'conv-persisted-calculator',
  conversations: [
    {
      id: 'conv-persisted-calculator',
      title: '持久化计算器会话',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T01:00:00.000Z',
      workspacePluginId: 'workspace-persisted-calculator',
      turns: [
        { role: 'user', content: '做一个可以连续计算的网页计算器插件' },
        {
          role: 'assistant',
          content: '插件草稿已经准备好，可以在右侧继续检查。',
          status: 'done',
          parts: [
            { type: 'text', content: '插件草稿已经准备好，可以在右侧继续检查。' },
          ],
        },
      ],
      stagedDraft: {
        ...persistedManifest,
        files: [
          { path: 'manifest.json', content: `${JSON.stringify(persistedManifest, null, 2)}\n` },
          { path: 'ui/index.html', content: '<!doctype html><title>Calculator</title>' },
        ],
      },
    },
  ],
};

test.describe('CreatorWorkspace', () => {
  test('通过 develop-plugins 入口显示页面式空状态', async ({ page }) => {
    await openCreatorWorkspace(page);

    await expect(page.getByText('插件 Agent', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '描述你想构建的插件' })).toBeVisible();
    await expect(page.getByText('还没有历史会话', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('描述要创建或修改的插件…')).toBeVisible();
    await expect(page.getByText('AI 插件创建器', { exact: true })).toHaveCount(0);
  });

  test('精简 composer 的加号菜单承载高级操作', async ({ page }) => {
    await openCreatorWorkspace(page);

    await expect(page.getByTitle('选择工作模式')).toBeVisible();
    await expect(page.getByTitle('选择模型档位')).toBeVisible();
    await expect(page.getByRole('button', { name: '发送' })).toBeDisabled();

    await page.getByRole('button', { name: '添加上下文与更多操作' }).click();
    await expect(page.getByText('添加到本轮', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '选择文件夹', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /技能（已启用 \d+ 个）/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '优化提示词' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '语音输入' })).toBeVisible();
  });

  test('输入后只出现一个上下文详情入口', async ({ page }) => {
    await openCreatorWorkspace(page);

    const input = page.getByPlaceholder('描述要创建或修改的插件…');
    const contextEntry = page.locator('button[title^="查看上下文详情"]');
    await expect(contextEntry).toHaveCount(0);

    await input.fill('做一个带界面的计算器插件');
    await expect(input).toHaveValue('做一个带界面的计算器插件');
    await expect(page.getByRole('button', { name: '发送' })).toBeEnabled();
    await expect(contextEntry).toHaveCount(1);
    await expect(page.getByText('context', { exact: true })).toHaveCount(0);

    await contextEntry.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('上下文详情', { exact: true })).toBeVisible();
    await expect(dialog.getByText('模型窗口', { exact: true })).toBeVisible();
    await expect(dialog.getByText('压缩进度', { exact: true })).toBeVisible();
  });

  test('恢复持久化会话与插件草稿 Inspector', async ({ page }) => {
    await openCreatorWorkspace(page, persistedCreatorFixture);

    await expect(page.getByText('持久化计算器会话', { exact: true })).toBeVisible();
    await expect(page.getByText('做一个可以连续计算的网页计算器插件', { exact: true })).toBeVisible();
    await expect(page.getByText('插件草稿已经准备好，可以在右侧继续检查。', { exact: true })).toBeVisible();
    const inspector = page.getByRole('heading', { name: '插件草稿' }).locator('xpath=ancestor::aside');
    await expect(inspector).toBeVisible();
    await expect(inspector.locator('input').first()).toHaveValue('持久化计算器');
    await expect(page.locator('button[title^="查看上下文详情"]')).toHaveCount(1);
    await expect(page.getByText('context', { exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: '文件' }).click();
    await expect(page.getByText('文件产物', { exact: true })).toBeVisible();
    await expect(page.getByText('ui/index.html', { exact: true })).toBeVisible();

    await page.reload();
    await page.waitForLoadState('networkidle');
    await enterCreatorWorkspace(page);
    await expect(page.getByText('持久化计算器会话', { exact: true })).toBeVisible();
    const restoredInspector = page.getByRole('heading', { name: '插件草稿' }).locator('xpath=ancestor::aside');
    await expect(restoredInspector).toBeVisible();
    await expect(restoredInspector.locator('input').first()).toHaveValue('持久化计算器');
  });
});
