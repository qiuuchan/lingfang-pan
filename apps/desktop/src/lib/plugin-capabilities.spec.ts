import { describe, it, expect } from 'vitest';

import {
  isAiCapability,
  capabilityRequiresAdmin,
  normalizeAiCapabilityAdmin,
} from './plugin-capabilities';

describe('isAiCapability', () => {
  it('returns true for known AI capability kinds', () => {
    expect(isAiCapability('llm.chat')).toBe(true);
    expect(isAiCapability('image.generate')).toBe(true);
  });

  it('returns false for other strings', () => {
    expect(isAiCapability('webhook')).toBe(false);
    expect(isAiCapability('')).toBe(false);
    expect(isAiCapability('llm.chat ')).toBe(false);
    expect(isAiCapability('LLM.CHAT')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isAiCapability(0)).toBe(false);
    expect(isAiCapability(1)).toBe(false);
    expect(isAiCapability(null)).toBe(false);
    expect(isAiCapability(undefined)).toBe(false);
    expect(isAiCapability({ kind: 'llm.chat' })).toBe(false);
    expect(isAiCapability(['llm.chat'])).toBe(false);
    expect(isAiCapability(true)).toBe(false);
  });
});

describe('capabilityRequiresAdmin', () => {
  it('returns false for AI capabilities regardless of the value', () => {
    expect(capabilityRequiresAdmin('llm.chat', true)).toBe(false);
    expect(capabilityRequiresAdmin('llm.chat', false)).toBe(false);
    expect(capabilityRequiresAdmin('llm.chat', undefined)).toBe(false);
    expect(capabilityRequiresAdmin('image.generate', true)).toBe(false);
    expect(capabilityRequiresAdmin('image.generate', undefined)).toBe(false);
  });

  it('returns true for non-AI capabilities when value is exactly true', () => {
    expect(capabilityRequiresAdmin('webhook', true)).toBe(true);
    expect(capabilityRequiresAdmin('fs.write', true)).toBe(true);
    expect(capabilityRequiresAdmin(null, true)).toBe(true);
    expect(capabilityRequiresAdmin(undefined, true)).toBe(true);
  });

  it('returns false for non-AI capabilities when value is not exactly true', () => {
    expect(capabilityRequiresAdmin('webhook', false)).toBe(false);
    expect(capabilityRequiresAdmin('webhook', undefined)).toBe(false);
    expect(capabilityRequiresAdmin('webhook', null)).toBe(false);
    expect(capabilityRequiresAdmin('webhook', 1)).toBe(false);
    expect(capabilityRequiresAdmin('webhook', 'true')).toBe(false);
  });
});

describe('normalizeAiCapabilityAdmin', () => {
  it('forces requires_admin to false for AI capabilities', () => {
    expect(normalizeAiCapabilityAdmin({ kind: 'llm.chat', requires_admin: true })).toEqual({
      kind: 'llm.chat',
      requires_admin: false,
    });
    expect(normalizeAiCapabilityAdmin({ kind: 'image.generate', requires_admin: true })).toEqual({
      kind: 'image.generate',
      requires_admin: false,
    });
  });

  it('keeps requires_admin true for non-AI capabilities that ask for it', () => {
    expect(normalizeAiCapabilityAdmin({ kind: 'webhook', requires_admin: true })).toEqual({
      kind: 'webhook',
      requires_admin: true,
    });
  });

  it('treats a missing requires_admin as undefined and yields false', () => {
    expect(normalizeAiCapabilityAdmin({ kind: 'webhook' })).toEqual({
      kind: 'webhook',
      requires_admin: false,
    });
    expect(normalizeAiCapabilityAdmin({ kind: 'llm.chat' })).toEqual({
      kind: 'llm.chat',
      requires_admin: false,
    });
  });

  it('preserves the other fields of the capability', () => {
    const capability = {
      kind: 'llm.chat',
      requires_admin: true,
      name: 'Chat',
      scopes: ['read'],
      config: { model: 'gpt' },
    };

    const result = normalizeAiCapabilityAdmin(capability);

    expect(result).toEqual({
      kind: 'llm.chat',
      requires_admin: false,
      name: 'Chat',
      scopes: ['read'],
      config: { model: 'gpt' },
    });
    expect(result.scopes).toBe(capability.scopes);
    expect(result.config).toBe(capability.config);
  });

  it('does not mutate the input capability', () => {
    const capability = { kind: 'llm.chat', requires_admin: true };

    const result = normalizeAiCapabilityAdmin(capability);

    expect(capability.requires_admin).toBe(true);
    expect(result).not.toBe(capability);
  });
});
