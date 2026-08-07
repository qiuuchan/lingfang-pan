import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationKey,
  detectDuplicateOutput,
  loadConversations,
  mergeStreamingText,
  saveConversations,
  selectedConversationKey,
  type CreatorConversation,
} from './creator-session';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('creator session storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses tenant keys before user fallback keys', () => {
    expect(conversationKey('user-1', 'tenant-1')).toBe('lf:creator-conversations:tenant-1');
    expect(selectedConversationKey('user-1', 'tenant-1')).toBe('lf:creator-selected:tenant-1');
    expect(conversationKey('user-1', null)).toBe('lf:creator-conversations:user-1');
    expect(selectedConversationKey('user-1', null)).toBe('lf:creator-selected:user-1');
    expect(conversationKey(null, null)).toBe('lf:creator-conversations:none');
    expect(selectedConversationKey(null, null)).toBe('lf:creator-selected:none');
  });

  it('normalizes legacy persisted conversations', () => {
    localStorage.setItem(
      conversationKey('user-1', null),
      JSON.stringify([
        null,
        { id: 42, turns: [] },
        {
          id: 'legacy-conversation',
          title: 42,
          turns: [
            { role: 'user', content: 'legacy request', status: 'unknown' },
            {
              role: 'assistant',
              content: 'legacy response',
              status: 'done',
              streaming: true,
              parts: [
                { type: 'text', content: 'answer' },
                { type: 'tool', name: 'Read', status: 'ok' },
                {
                  type: 'question',
                  question: 'continue?',
                  allowFreeText: false,
                  multiSelect: true,
                },
                { type: 'unknown' },
              ],
            },
            { role: 'system', content: 'ignored' },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          workspacePluginId: 123,
          userEdits: { name: 'Renamed plugin' },
          todos: [
            { content: 'Keep me', status: 'invalid', priority: 'invalid' },
            { content: '', status: 'completed', priority: 'high' },
            null,
          ],
        },
      ])
    );

    const conversations = loadConversations('user-1', null);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: 'legacy-conversation',
      title: '历史对话',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      workspacePluginId: null,
      userEdits: { name: 'Renamed plugin' },
      todos: [{ content: 'Keep me', status: 'pending', priority: 'medium' }],
    });
    expect(conversations[0].turns).toHaveLength(2);
    expect(conversations[0].turns[0]).toEqual({ role: 'user', content: 'legacy request' });
    expect(conversations[0].turns[1]).toMatchObject({
      role: 'assistant',
      content: 'legacy response',
      status: 'done',
      streaming: true,
    });
    expect(conversations[0].turns[1].parts).toEqual([
      { type: 'text', content: 'answer' },
      {
        type: 'tool',
        toolCallId: 'legacy-tool-1',
        name: 'Read',
        args: undefined,
        result: undefined,
        status: 'ok',
      },
      {
        type: 'question',
        toolCallId: 'legacy-question-2',
        question: 'continue?',
        options: undefined,
        allowFreeText: false,
        multiSelect: true,
        answer: undefined,
        answered: false,
      },
    ]);
  });

  it('saves at most 30 conversations without modelContent', () => {
    const conversations: CreatorConversation[] = Array.from({ length: 35 }, (_, index) => ({
      id: `conversation-${index}`,
      title: `Conversation ${index}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      turns: [{ role: 'user', content: `visible-${index}`, modelContent: `private-${index}` }],
    }));

    saveConversations('user-1', 'tenant-1', conversations);

    const raw = localStorage.getItem(conversationKey('user-1', 'tenant-1'));
    const persisted = JSON.parse(raw ?? '[]') as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(30);
    expect(persisted[0]).toMatchObject({ id: 'conversation-0' });
    expect(persisted[29]).toMatchObject({ id: 'conversation-29' });
    expect(
      persisted.every((conversation) => {
        const turns = conversation.turns as Array<Record<string, unknown>>;
        return turns.every((turn) => !('modelContent' in turn));
      })
    ).toBe(true);
    expect(conversations[0].turns[0].modelContent).toBe('private-0');
  });
});

describe('creator session streaming text helpers', () => {
  it('merges cumulative and overlapping streaming text', () => {
    expect(mergeStreamingText('hello', 'hello world')).toBe('hello world');
    expect(mergeStreamingText('prefix-abcdefghijklmnop', 'abcdefghijklmnop-suffix')).toBe(
      'prefix-abcdefghijklmnop-suffix'
    );
  });

  it('detects duplicate output and keeps distinct output', () => {
    const duplicate = `duplicate-response-${'a'.repeat(64)}`;
    const distinct = `distinct-response-${'b'.repeat(64)}`;

    expect(detectDuplicateOutput(`before ${duplicate} after`, duplicate)).toBeNull();
    expect(detectDuplicateOutput(duplicate, distinct)).toBe(distinct);
    expect(detectDuplicateOutput('已有内容', '短增量')).toBe('短增量');
  });
});
