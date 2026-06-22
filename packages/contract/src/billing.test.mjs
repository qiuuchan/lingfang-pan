import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TierSchema,
  ChatRelayInputSchema,
  ImageRelayInputSchema,
  injectSystemGuardRule,
  DEFAULT_AI_USAGE_GUARD_RULE,
  PlatformApiKeyPublicSchema,
  RelayModelsResponseSchema,
} from './billing.ts';

// 需求 #3：系统提示词规则注入必须在所有路径生效，且不破坏既有 system 内容。
test('injectSystemGuardRule prepends a system message when none exists', () => {
  const out = injectSystemGuardRule([{ role: 'user', content: 'hi' }]);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, DEFAULT_AI_USAGE_GUARD_RULE);
  assert.equal(out.length, 2);
  assert.equal(out[1].role, 'user');
});

test('injectSystemGuardRule appends a separate system segment when system already present (no mutation of original)', () => {
  const original = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '画一张猫' },
  ];
  const out = injectSystemGuardRule(original);
  assert.equal(out.length, 3);
  assert.equal(out[0].content, '你是助手'); // 原 system 保留
  assert.equal(out[2].role, 'system'); // 规则作为独立 system 段追加在末尾
  assert.equal(out[2].content, DEFAULT_AI_USAGE_GUARD_RULE);
  // 不 mutate 入参
  assert.equal(original.length, 2);
});

test('injectSystemGuardRule is a no-op when rule is blank (允许后台清空规则)', () => {
  const out = injectSystemGuardRule([{ role: 'user', content: 'hi' }], '   ');
  assert.equal(out.length, 1);
});

// 需求 #5：协议层强制两版本——model 只接受 'fast'/'premium' 哨兵。
test('TierSchema accepts only fast/premium', () => {
  assert.equal(TierSchema.safeParse('fast').success, true);
  assert.equal(TierSchema.safeParse('premium').success, true);
  assert.equal(TierSchema.safeParse('gpt-4o').success, false);
  assert.equal(TierSchema.safeParse('').success, false);
});

test('ChatRelayInputSchema rejects custom model ids (protocol enforces two tiers)', () => {
  const ok = ChatRelayInputSchema.safeParse({
    model: 'fast',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(ok.success, true);
  const bad = ChatRelayInputSchema.safeParse({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(bad.success, false);
});

test('ImageRelayInputSchema enforces prompt + tier + bounds n', () => {
  assert.equal(
    ImageRelayInputSchema.safeParse({ model: 'premium', prompt: 'a cat' }).success,
    true,
  );
  // n 上限 10
  assert.equal(
    ImageRelayInputSchema.safeParse({ model: 'premium', prompt: 'x', n: 11 }).success,
    false,
  );
  // 空 prompt 拒绝
  assert.equal(
    ImageRelayInputSchema.safeParse({ model: 'fast', prompt: '' }).success,
    false,
  );
});

// 需求 #4：API Key 出参永不回明文/keyHash，只回 keyPrefix。
test('PlatformApiKeyPublicSchema does not leak plaintextKey or keyHash', () => {
  const publicShape = PlatformApiKeyPublicSchema.shape;
  assert.equal('plaintextKey' in publicShape, false);
  assert.equal('keyHash' in publicShape, false);
  assert.equal('keyPrefix' in publicShape, true);
});

test('RelayModelsResponseSchema lists exactly the two tiers', () => {
  const parsed = RelayModelsResponseSchema.parse({
    data: [{ id: 'fast' }, { id: 'premium' }],
  });
  assert.equal(parsed.data.length, 2);
});
