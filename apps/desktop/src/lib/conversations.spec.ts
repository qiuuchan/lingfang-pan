import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeConversationKey,
  conversationOwner,
  filterConversationsForOwner,
  readActiveId,
  writeActiveId,
} from './conversations';
import type { ConversationMeta } from './plugin-draft';

function meta(sessionId: string, ownerUserId?: string | null, ownerTenantId?: string | null): ConversationMeta {
  return {
    sessionId,
    tool: 'claude',
    status: 'exited',
    startedAt: '1',
    ownerUserId,
    ownerTenantId,
  };
}

function installMemoryStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() { return map.size; },
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
}

describe('conversation owner helpers', () => {
  beforeEach(() => installMemoryStorage());

  it('activeId key includes userId and tenantId to avoid account switching leakage', () => {
    expect(activeConversationKey('team-1', 'user-a')).toBe('lf:active-conversation:team-1:user-a');
    expect(activeConversationKey('team-1', 'user-b')).toBe('lf:active-conversation:team-1:user-b');
  });

  it('read/write activeId is isolated by current user', () => {
    writeActiveId(conversationOwner('user-a', 'team-1'), 's-a');
    writeActiveId(conversationOwner('user-b', 'team-1'), 's-b');

    expect(readActiveId(conversationOwner('user-a', 'team-1'))).toBe('s-a');
    expect(readActiveId(conversationOwner('user-b', 'team-1'))).toBe('s-b');
  });

  it('filters session records to the current owner and hides unowned legacy records', () => {
    const records = [
      meta('owned-a', 'user-a', 'team-1'),
      meta('owned-b', 'user-b', 'team-1'),
      meta('legacy-without-owner'),
    ];

    expect(filterConversationsForOwner(records, conversationOwner('user-a', 'team-1')).map((item) => item.sessionId))
      .toEqual(['owned-a']);
  });
});
