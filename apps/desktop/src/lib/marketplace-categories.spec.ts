// marketplace-categories.spec.ts — Task 1 自动分类回归测试。
import { describe, it, expect } from 'vitest';
import {
  categorizePlugin,
  categoryLabel,
  filterByCategory,
  CATEGORIES,
  type CategoryKey,
} from './marketplace-categories';
import type { MarketPlugin } from './marketplace-categories';

function plug(name: string, description = '', extra: Partial<MarketPlugin> = {}): MarketPlugin {
  return { id: name, name, description, ...extra } as MarketPlugin;
}

describe('categorizePlugin', () => {
  it('按名称/描述关键词归类', () => {
    expect(categorizePlugin(plug('AI 总结助手', '自动总结会议内容'))).toBe('ai');
    expect(categorizePlugin(plug('会议纪要生成器', '整理待办与清单'))).toBe('productivity');
    expect(categorizePlugin(plug('代码审查 Bot', '静态分析与调试'))).toBe('dev');
    expect(categorizePlugin(plug('数据可视化面板', '图表与统计'))).toBe('data');
    expect(categorizePlugin(plug('换衣预览', '图像处理'))).toBe('media');
    expect(categorizePlugin(plug('文件搜索', '资源管理器'))).toBe('files');
    expect(categorizePlugin(plug('HTTP 爬虫', '抓取接口数据'))).toBe('network');
    expect(categorizePlugin(plug('系统信息', '监控 CPU 性能'))).toBe('system');
  });

  it('无匹配归入 other', () => {
    expect(categorizePlugin(plug('神秘插件', '完全无关的描述'))).toBe('other');
  });

  it('后端显式 category 优先（向前兼容）', () => {
    const p = plug('x', 'y', { category: 'dev' } as unknown as Partial<MarketPlugin>);
    expect(categorizePlugin(p as MarketPlugin)).toBe('dev');
  });

  it('优先级：更具体的分类先匹配', () => {
    // "AI 代码助手"：dev 与 ai 都可能命中，ai 在前 → ai。
    expect(categorizePlugin(plug('AI 代码助手', '智能对话生成代码'))).toBe('ai');
  });
});

describe('categoryLabel', () => {
  it('返回中文标签', () => {
    expect(categoryLabel('ai')).toBe('AI 与助手');
    expect(categoryLabel('other')).toBe('其他');
  });
});

describe('filterByCategory', () => {
  const list: MarketPlugin[] = [
    plug('AI 总结', '智能助手'),
    plug('代码工具', '开发调试'),
    plug('神秘物', '不知名'),
  ];

  it('all 返回全部（叠加 q 子串）', () => {
    expect(filterByCategory(list, 'all', '').length).toBe(3);
    expect(filterByCategory(list, 'all', '代码').length).toBe(1);
  });

  it('按分类过滤', () => {
    expect(filterByCategory(list, 'ai' as CategoryKey, '').length).toBe(1);
    expect(filterByCategory(list, 'dev' as CategoryKey, '').length).toBe(1);
    expect(filterByCategory(list, 'other' as CategoryKey, '').length).toBe(1);
  });
});

describe('CATEGORIES', () => {
  it('预置分类覆盖主要场景', () => {
    const keys = CATEGORIES.map((c) => c.key);
    expect(keys).toContain('ai');
    expect(keys).toContain('dev');
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });
});
