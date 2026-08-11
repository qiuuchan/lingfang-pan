// P0-9 AI 内容审核判定纯函数单测（机制先行，mock 供应商）。
//
// 目标：覆盖 judgeModeration 的全部语义分支（含工单强制要求的反向用例）：
//  - 开关 OFF        → 放行（不审核）。
//  - 开关 ON + 无供应商 → 拒绝 moderation_unavailable（fail-closed，配置不完整不静默放行）。
//  - 开关 ON + 供应商抛错 → 拒绝 moderation_unavailable（核心反向用例：不可用即拒，绝不静默放行）。
//  - 开关 ON + 供应商超时（视为抛错）→ 拒绝。
//  - 开关 ON + 命中敏感词 → 拒绝 sensitive_content + audit=true（须写审计）。
//  - 开关 ON + 供应商判安全 → 放行。
import { describe, expect, it, vi } from 'vitest';
import { judgeModeration, type ModerationProvider } from './ai-moderation';

/** 构造一个会抛错的供应商（模拟不可用/超时）。 */
function throwingProvider(): ModerationProvider {
  return { judge: vi.fn(async () => {
    throw new Error('upstream timeout');
  }) };
}

/** 构造一个返回固定 flagged 的供应商。 */
function flagProvider(flagged: boolean): ModerationProvider {
  return { judge: vi.fn(async () => ({ flagged, categories: flagged ? ['violence'] : [] })) };
}

describe('judgeModeration（P0-9 审核判定纯函数）', () => {
  it('开关 OFF：直接放行，不调用供应商', async () => {
    const provider = flagProvider(true); // 即便供应商会判违规，关掉也不该拦
    const v = await judgeModeration({ enabled: false, provider }, '任何内容');
    expect(v).toEqual({ allowed: true });
    expect(provider.judge).not.toHaveBeenCalled();
  });

  it('反向用例-1 开关 ON 但无供应商：配置不完整 → 拒绝 moderation_unavailable（fail-closed）', async () => {
    const v = await judgeModeration({ enabled: true, provider: null }, 'hello');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe('moderation_unavailable');
      expect(v.audit).toBe(true);
    }
  });

  it('反向用例-2 开关 ON 且供应商抛错/超时：→ 拒绝 moderation_unavailable（绝不静默放行）', async () => {
    const provider = throwingProvider();
    const v = await judgeModeration({ enabled: true, provider }, '用户正常提问');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toEqual('moderation_unavailable');
      expect(v.audit).toBe(true);
    }
    expect(provider.judge).toHaveBeenCalledTimes(1);
  });

  it('反向用例-3 开关 ON 且命中敏感内容：→ 拒绝 sensitive_content + 需审计', async () => {
    const provider = flagProvider(true);
    const v = await judgeModeration({ enabled: true, provider }, '违禁内容');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toEqual('sensitive_content');
      expect(v.audit).toBe(true);
    }
  });

  it('正向用例 开关 ON 且供应商判安全：→ 放行', async () => {
    const provider = flagProvider(false);
    const v = await judgeModeration({ enabled: true, provider }, '正常的插件创建建议');
    expect(v).toEqual({ allowed: true });
  });
});
