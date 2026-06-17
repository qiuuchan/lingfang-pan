import {
  aggregateToolCards,
  extractAskUserQuestionsForCard,
  type AskUserQuestion,
} from '@/lib/plugin-draft';

export interface ChatSegment {
  stream: 'stdout' | 'stderr' | 'thought' | 'tool';
  text: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatOutputItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant-text'; text: string; live: boolean }
  | { id: string; type: 'reasoning'; text: string; live: boolean; defaultOpen: boolean }
  | { id: string; type: 'diagnostic'; text: string; live: boolean }
  | { id: string; type: 'tool'; name: string; argsText: string; questions: AskUserQuestion[]; live: boolean };

export function buildChatOutputItems(
  turns: ChatTurn[],
  segments: ChatSegment[],
  streaming: boolean,
): ChatOutputItem[] {
  const display = resolveChatDisplay(turns, segments, streaming);
  const items = buildTurnItems(display.historyTurns);
  if (display.currentUser) {
    items.push(buildUserItem(display.currentUser, display.historyTurns.length));
  }
  if (display.reasoningText) {
    items.push({
      id: 'live-reasoning',
      type: 'reasoning',
      text: display.reasoningText,
      live: display.assistantLive,
      defaultOpen: false,
    });
  }
  if (display.assistantText) {
    items.push({
      id: 'live-text',
      type: 'assistant-text',
      text: display.assistantText,
      live: display.assistantLive,
    });
  }
  items.push(...buildDiagnosticItems(segments, display.assistantLive));
  items.push(...buildToolItems(segments, display.assistantLive));
  return items;
}

function buildTurnItems(turns: ChatTurn[]): ChatOutputItem[] {
  return turns.flatMap((turn, index): ChatOutputItem[] => {
    const text = turn.content.trimEnd();
    if (!text) return [];
    return turn.role === 'user'
      ? [{ id: `turn-${index}`, type: 'user', text }]
      : [{ id: `turn-${index}`, type: 'assistant-text', text, live: false }];
  });
}

function buildUserItem(turn: ChatTurn, index: number): ChatOutputItem {
  return { id: `live-user-${index}`, type: 'user', text: turn.content.trimEnd() };
}

function resolveChatDisplay(
  turns: ChatTurn[],
  segments: ChatSegment[],
  streaming: boolean,
): {
  historyTurns: ChatTurn[];
  currentUser: ChatTurn | null;
  assistantText: string;
  assistantLive: boolean;
  reasoningText: string;
} {
  const reasoningText = segmentText(segments, 'thought', '');
  const lastTurnIndex = turns.length - 1;
  if (!turns.length) {
    return {
      historyTurns: [],
      currentUser: null,
      assistantText: streaming ? liveResponseText(segments) : '',
      assistantLive: streaming,
      reasoningText,
    };
  }

  const duplicatePending = findTrailingDuplicateUserIndex(turns);
  if (duplicatePending >= 0) {
    if (streaming) {
      return {
        historyTurns: turns.slice(0, duplicatePending),
        currentUser: turns[lastTurnIndex] || null,
        assistantText: liveResponseText(segments),
        assistantLive: true,
        reasoningText,
      };
    }

    return {
      historyTurns: turns.slice(0, duplicatePending),
      currentUser: turns[duplicatePending] || null,
      assistantText: turns[duplicatePending + 1]?.content.trimEnd() || '',
      assistantLive: false,
      reasoningText,
    };
  }

  if (turns[lastTurnIndex]?.role === 'assistant') {
    const currentUserIndex = findLastUserIndex(turns, lastTurnIndex);
    return {
      historyTurns: currentUserIndex >= 0 ? turns.slice(0, currentUserIndex) : turns.slice(0, lastTurnIndex),
      currentUser: currentUserIndex >= 0 ? turns[currentUserIndex] : null,
      assistantText: streaming ? liveResponseText(segments) : turns[lastTurnIndex].content.trimEnd(),
      assistantLive: streaming,
      reasoningText,
    };
  }

  return {
    historyTurns: turns.slice(0, lastTurnIndex),
    currentUser: turns[lastTurnIndex] || null,
    assistantText: streaming ? liveResponseText(segments) : '',
    assistantLive: streaming,
    reasoningText,
  };
}

function findTrailingDuplicateUserIndex(turns: ChatTurn[]): number {
  const lastIndex = turns.length - 1;
  const assistantIndex = lastIndex - 1;
  const userIndex = lastIndex - 2;
  if (userIndex < 0) return -1;
  if (turns[lastIndex]?.role !== 'user' || turns[assistantIndex]?.role !== 'assistant' || turns[userIndex]?.role !== 'user') {
    return -1;
  }
  return turns[userIndex].content === turns[lastIndex].content ? userIndex : -1;
}

function findLastUserIndex(turns: ChatTurn[], beforeIndex: number): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return i;
  }
  return -1;
}

function buildDiagnosticItems(segments: ChatSegment[], live: boolean): ChatOutputItem[] {
  return segments
    .filter((segment) => segment.stream === 'stderr' && segment.text.trim())
    .map((segment, index) => ({
      id: `live-diagnostic-${index}`,
      type: 'diagnostic' as const,
      text: segment.text.trimEnd(),
      live,
    }));
}

function buildToolItems(segments: ChatSegment[], live: boolean): ChatOutputItem[] {
  const toolSegments = segments.filter((segment) => segment.stream === 'tool').map((segment) => segment.text);
  return aggregateToolCards(toolSegments).map((card, index) => ({
    id: `live-tool-${index}`,
    type: 'tool' as const,
    name: card.name || '工具',
    argsText: card.inputText,
    questions: extractAskUserQuestionsForCard(card),
    live,
  }));
}

function liveResponseText(segments: ChatSegment[]): string {
  return segmentText(segments, 'stdout', '');
}

function segmentText(segments: ChatSegment[], stream: ChatSegment['stream'], joiner: string): string {
  return segments
    .filter((segment) => segment.stream === stream)
    .map((segment) => segment.text)
    .join(joiner)
    .trimEnd();
}
