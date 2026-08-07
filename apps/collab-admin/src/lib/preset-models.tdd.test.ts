import { describe, it, expect } from 'vitest';
import {
  PRESET_MODELS,
  PRESET_IMAGE_MODELS,
  getPresetModels,
  type PresetModel,
} from '@/lib/preset-models';

// preset-models 纯逻辑单测（TDD 重建）。
// 该模块是渠道创建表单的数据源：provider 选定后决定可勾选的模型清单，
// 清单结构错误（重复 id / 缺 label / 非数组返回）会直接让下拉渲染崩溃或提交脏数据，
// 因此这里既测 getPresetModels 的分发逻辑，也测常量表本身的数据完整性。

const CHAT_PROVIDERS = ['openai', 'anthropic', 'azure', 'deepseek', 'moonshot', 'qwen', 'custom'];

describe('PRESET_MODELS（provider 分组常量表）', () => {
  it('覆盖全部 provider 白名单 key', () => {
    expect(Object.keys(PRESET_MODELS).sort()).toEqual([...CHAT_PROVIDERS].sort());
  });

  it('每个分组都是数组，custom 为空（纯手输）', () => {
    for (const provider of CHAT_PROVIDERS) {
      expect(Array.isArray(PRESET_MODELS[provider])).toBe(true);
    }
    expect(PRESET_MODELS.custom).toEqual([]);
    // 除 custom 外都必须有内容，否则下拉是空的。
    for (const provider of CHAT_PROVIDERS.filter((p) => p !== 'custom')) {
      expect(PRESET_MODELS[provider].length).toBeGreaterThan(0);
    }
  });

  it('组内 model id 唯一（重复会导致 React key 冲突 / 勾选串台）', () => {
    for (const [provider, models] of Object.entries(PRESET_MODELS)) {
      const ids = models.map((m) => m.id);
      expect(new Set(ids).size, `${provider} 存在重复 id`).toBe(ids.length);
    }
  });

  it('每个模型字段合法：id/label 非空字符串，contextWindow 为正整数', () => {
    for (const [provider, models] of Object.entries(PRESET_MODELS)) {
      for (const m of models) {
        expect(typeof m.id, `${provider}.id`).toBe('string');
        expect(m.id.trim().length).toBeGreaterThan(0);
        expect(typeof m.label, `${provider}/${m.id}.label`).toBe('string');
        expect(m.label.trim().length).toBeGreaterThan(0);
        expect(Number.isInteger(m.contextWindow), `${provider}/${m.id}.contextWindow`).toBe(true);
        expect(m.contextWindow).toBeGreaterThan(0);
      }
    }
  });

  it('supportsReasoning 要么缺省，要么为 true（不写 false 占位）', () => {
    for (const models of Object.values(PRESET_MODELS)) {
      for (const m of models) {
        if ('supportsReasoning' in m) {
          expect(m.supportsReasoning).toBe(true);
        }
      }
    }
  });

  it('推理模型标记符合预期（抽样：o3 / claude-opus-4-8 / deepseek-reasoner）', () => {
    const find = (provider: string, id: string) =>
      PRESET_MODELS[provider].find((m) => m.id === id) as PresetModel;
    expect(find('openai', 'o3').supportsReasoning).toBe(true);
    expect(find('anthropic', 'claude-opus-4-8').supportsReasoning).toBe(true);
    expect(find('deepseek', 'deepseek-reasoner').supportsReasoning).toBe(true);
    // 非推理模型不应带该标记。
    expect(find('openai', 'gpt-4.1').supportsReasoning).toBeUndefined();
    expect(find('deepseek', 'deepseek-chat').supportsReasoning).toBeUndefined();
  });
});

describe('PRESET_IMAGE_MODELS（生图预设）', () => {
  it('包含 gpt-image-1 / dall-e-3 / dall-e-2 且 id 唯一', () => {
    const ids = PRESET_IMAGE_MODELS.map((m) => m.id);
    expect(ids).toEqual(['gpt-image-1', 'dall-e-3', 'dall-e-2']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('生图模型不吃上下文，contextWindow 恒为 0', () => {
    for (const m of PRESET_IMAGE_MODELS) {
      expect(m.contextWindow).toBe(0);
      expect(m.label.trim().length).toBeGreaterThan(0);
      expect(m.supportsReasoning).toBeUndefined();
    }
  });
});

describe('getPresetModels(provider, kind)', () => {
  it('CHAT：已知 provider 返回对应分组', () => {
    for (const provider of CHAT_PROVIDERS) {
      expect(getPresetModels(provider, 'CHAT')).toEqual(PRESET_MODELS[provider]);
    }
    expect(getPresetModels('openai', 'CHAT')[0]).toEqual({
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      contextWindow: 272000,
    });
  });

  it('CHAT：custom 返回空数组', () => {
    expect(getPresetModels('custom', 'CHAT')).toEqual([]);
  });

  it('CHAT：未知 provider 回退空数组，而非 undefined', () => {
    expect(getPresetModels('not-a-provider', 'CHAT')).toEqual([]);
    expect(getPresetModels('gemini', 'CHAT')).toEqual([]);
  });

  it('CHAT：空串 provider 回退空数组', () => {
    expect(getPresetModels('', 'CHAT')).toEqual([]);
  });

  it('CHAT：provider 大小写敏感，OpenAI 不等于 openai', () => {
    expect(getPresetModels('OpenAI', 'CHAT')).toEqual([]);
    expect(getPresetModels('OPENAI', 'CHAT')).toEqual([]);
  });

  it('CHAT：原型链上的 key 不得被当成分组（必须仍返回数组）', () => {
    // provider 字符串来自接口/表单，可能是任意值；若用裸下标查找，
    // 'constructor' / 'toString' 会命中 Object.prototype 上的函数，
    // 调用方 .map 立刻抛错。
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const out = getPresetModels(key, 'CHAT');
      expect(Array.isArray(out), `provider=${key} 返回非数组`).toBe(true);
      expect(out).toEqual([]);
    }
  });

  it('IMAGE：忽略 provider，一律返回生图预设', () => {
    for (const provider of [...CHAT_PROVIDERS, '', 'unknown-provider', 'constructor']) {
      expect(getPresetModels(provider, 'IMAGE')).toEqual(PRESET_IMAGE_MODELS);
    }
  });

  it('返回值始终是数组，可直接 map 渲染', () => {
    const cases: Array<[string, 'CHAT' | 'IMAGE']> = [
      ['openai', 'CHAT'],
      ['custom', 'CHAT'],
      ['nope', 'CHAT'],
      ['nope', 'IMAGE'],
    ];
    for (const [provider, kind] of cases) {
      const out = getPresetModels(provider, kind);
      expect(Array.isArray(out)).toBe(true);
      expect(() => out.map((m) => m.id)).not.toThrow();
    }
  });

  it('未知 provider 的空数组不共享引用，调用方 push 不污染后续调用', () => {
    const first = getPresetModels('unknown-x', 'CHAT');
    first.push({ id: 'injected', label: 'injected', contextWindow: 1 });
    expect(getPresetModels('unknown-y', 'CHAT')).toEqual([]);
  });
});
