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
  segments?: ChatSegment[];
}

export type ChatOutputItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant-text'; text: string; live: boolean }
  | { id: string; type: 'reasoning'; text: string; live: boolean; defaultOpen: boolean }
  | { id: string; type: 'diagnostic'; text: string; live: boolean }
  | { id: string; type: 'tool'; name: string; argsText: string; questions: AskUserQuestion[]; live: boolean }
  | { id: string; type: 'progress'; title: string; status: 'running' | 'done'; live: boolean };

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
  if (display.assistantSegments.length) {
    items.push(...buildAssistantItems({
      idPrefix: 'current',
      text: display.assistantText,
      segments: display.assistantSegments,
      live: display.assistantLive,
    }));
    return items;
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
  items.push(...buildAssistantResponseItems('live', display.assistantText, display.assistantLive));
  items.push(...buildDiagnosticItems(segments, display.assistantLive));
  items.push(...buildToolItems(segments, display.assistantLive));
  return items;
}

function buildTurnItems(turns: ChatTurn[]): ChatOutputItem[] {
  return turns.flatMap((turn, index): ChatOutputItem[] => {
    const text = turn.content.trimEnd();
    if (turn.role === 'user') {
      return text ? [{ id: `turn-${index}`, type: 'user', text }] : [];
    }
    return buildAssistantItems({
      idPrefix: `turn-${index}`,
      text,
      segments: turn.segments || [],
      live: false,
    });
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
  assistantSegments: ChatSegment[];
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
      assistantSegments: streaming ? [] : [],
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
        assistantSegments: [],
      };
    }

    const assistantTurn = turns[duplicatePending + 1];
    return {
      historyTurns: turns.slice(0, duplicatePending),
      currentUser: turns[duplicatePending] || null,
      assistantText: assistantTurn?.content.trimEnd() || '',
      assistantLive: false,
      reasoningText,
      assistantSegments: assistantTurn?.segments || [],
    };
  }

  if (turns[lastTurnIndex]?.role === 'assistant') {
    const currentUserIndex = findLastUserIndex(turns, lastTurnIndex);
    const assistantTurn = turns[lastTurnIndex];
    return {
      historyTurns: currentUserIndex >= 0 ? turns.slice(0, currentUserIndex) : turns.slice(0, lastTurnIndex),
      currentUser: currentUserIndex >= 0 ? turns[currentUserIndex] : null,
      assistantText: streaming ? liveResponseText(segments) : assistantTurn.content.trimEnd(),
      assistantLive: streaming,
      reasoningText,
      assistantSegments: streaming ? [] : assistantTurn.segments || [],
    };
  }

  return {
    historyTurns: turns.slice(0, lastTurnIndex),
    currentUser: turns[lastTurnIndex] || null,
    assistantText: streaming ? liveResponseText(segments) : '',
    assistantLive: streaming,
    reasoningText,
    assistantSegments: [],
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

function buildAssistantItems({
  idPrefix,
  text,
  segments,
  live,
}: {
  idPrefix: string;
  text: string;
  segments: ChatSegment[];
  live: boolean;
}): ChatOutputItem[] {
  if (!segments.length) {
    return buildAssistantResponseItems(idPrefix, text, live);
  }
  const items: ChatOutputItem[] = [];
  const reasoningText = segmentText(segments, 'thought', '');
  if (reasoningText) {
    items.push({
      id: `${idPrefix}-reasoning`,
      type: 'reasoning',
      text: reasoningText,
      live,
      defaultOpen: false,
    });
  }
  items.push(...buildAssistantResponseItems(idPrefix, text || segmentText(segments, 'stdout', ''), live));
  items.push(
    ...buildDiagnosticItems(segments, live).map((item, index) => ({
      ...item,
      id: `${idPrefix}-diagnostic-${index}`,
    })),
  );
  items.push(
    ...buildToolItems(segments, live).map((item, index) => ({
      ...item,
      id: `${idPrefix}-tool-${index}`,
    })),
  );
  return items;
}

function buildAssistantResponseItems(idPrefix: string, text: string, live: boolean): ChatOutputItem[] {
  if (!text) return [];
  const progressItems = parseProgressItems(text, live);
  if (progressItems.length) {
    return progressItems.map((item, index) => ({ ...item, id: `${idPrefix}-progress-${index}` }));
  }
  return [{ id: `${idPrefix}-text`, type: 'assistant-text', text, live }];
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

function parseProgressItems(
  text: string,
  live: boolean,
): Array<Omit<Extract<ChatOutputItem, { type: 'progress' }>, 'id'>> {
  const sentences = splitProgressSentences(text);
  if (!isDenseProgressLog(sentences)) return [];
  return sentences.map((sentence) => ({
    type: 'progress' as const,
    title: sentence.replace(/[：:]+$/, ''),
    status: isDoneSentence(sentence) ? 'done' as const : 'running' as const,
    live,
  }));
}

function splitProgressSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？])\s*/)
    .flatMap((line) => splitColonProgress(line.trim().replace(/[。！？]+$/, '')))
    .filter(Boolean);
}

function splitColonProgress(sentence: string): string[] {
  const match = sentence.match(/^(.{2,80}?[：:])(.+)$/);
  if (!match || !isProgressSentence(match[1])) return sentence ? [sentence] : [];
  return [match[1].replace(/[：:]+$/, ''), match[2].trim()].filter(Boolean);
}

function isDenseProgressLog(sentences: string[]): boolean {
  if (sentences.length < 4) return false;
  const progressCount = sentences.filter(isProgressSentence).length;
  return progressCount >= 4 && progressCount / sentences.length >= 0.75;
}

function isProgressSentence(sentence: string): boolean {
  return /^(现在|先|然后|接着|最后)?(开始|写|创建|验证|检查|测试|删除|移动|重命名|完成|已|全部|最后)/.test(sentence)
    || /完成$|通过$|已写好$|已删除$|已放根目录$|正确$/.test(sentence);
}

function isDoneSentence(sentence: string): boolean {
  return /完成$|通过$|已写好$|已删除$|已放根目录$|通过$|正确$/.test(sentence);
}
