import type { DraftTurn } from '@/lib/types';

export function lastTurnIndex(turns: DraftTurn[], role: DraftTurn['role']): number {
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index].role === role) return index;
  }
  return -1;
}

export function lastTurnContent(turns: DraftTurn[], role: DraftTurn['role']): string | undefined {
  const index = lastTurnIndex(turns, role);
  return index === -1 ? undefined : turns[index].content;
}

export function canConvertConversationToDraft(input: {
  activeId: string | null;
  hasDraft: boolean;
  streaming: boolean;
  turns: DraftTurn[];
}) {
  return Boolean(input.activeId)
    && !input.hasDraft
    && !input.streaming
    && lastTurnIndex(input.turns, 'assistant') !== -1;
}
