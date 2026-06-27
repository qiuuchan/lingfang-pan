// think-tags.ts — 将 relay 注入 content 的 <think>...</think> 拆成 UI 可渲染的思考/正文增量。

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface ThinkTagHandlers {
  onText: (text: string) => void;
  onReasoning: (text: string) => void;
  onReasoningEnd: () => void;
}

export interface ThinkTagStreamParser {
  feed: (chunk: string) => void;
  flush: () => void;
}

function indexOfTag(text: string, tag: string): number {
  return text.toLowerCase().indexOf(tag);
}

function pendingTagPrefixLength(text: string, tags: string[]): number {
  const lower = text.toLowerCase();
  let best = 0;
  for (const tag of tags) {
    const max = Math.min(lower.length, tag.length - 1);
    for (let len = 1; len <= max; len += 1) {
      if (lower.endsWith(tag.slice(0, len))) best = Math.max(best, len);
    }
  }
  return best;
}

function normalizedReasoning(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function createThinkTagStreamParser(handlers: ThinkTagHandlers): ThinkTagStreamParser {
  let buffer = '';
  let inThink = false;
  let sawThinkTag = false;
  let currentReasoning = '';
  let lastClosedReasoning = '';
  let pendingAfterThinkText = '';

  const emitText = (text: string) => {
    if (text) handlers.onText(text);
  };

  const flushPendingAfterThinkText = (dropExactLeak = false) => {
    if (!pendingAfterThinkText) return;
    const normalizedPending = normalizedReasoning(pendingAfterThinkText);
    if (!(dropExactLeak && normalizedPending && normalizedPending === lastClosedReasoning)) {
      emitText(pendingAfterThinkText);
    }
    pendingAfterThinkText = '';
  };

  const emitNormalText = (text: string) => {
    if (!text) return;
    if (sawThinkTag && lastClosedReasoning) {
      pendingAfterThinkText += text;
      const normalizedPending = normalizedReasoning(pendingAfterThinkText);
      if (!normalizedPending || lastClosedReasoning.startsWith(normalizedPending)) return;

      if (pendingAfterThinkText.startsWith(lastClosedReasoning)) {
        const visibleRest = pendingAfterThinkText.slice(lastClosedReasoning.length).replace(/^\s+/, '');
        pendingAfterThinkText = '';
        emitText(visibleRest);
        return;
      }

      flushPendingAfterThinkText();
      return;
    }
    emitText(text);
  };

  const emitReasoning = (text: string) => {
    if (!text) return;
    currentReasoning += text;
    handlers.onReasoning(text);
  };

  const endReasoning = () => {
    lastClosedReasoning = normalizedReasoning(currentReasoning);
    currentReasoning = '';
    handlers.onReasoningEnd();
  };

  const consumeNormalModeCloseTag = (closeIdx: number) => {
    const beforeClose = buffer.slice(0, closeIdx);
    const afterClose = buffer.slice(closeIdx + CLOSE_TAG.length);

    if (beforeClose) {
      const candidate = pendingAfterThinkText + beforeClose;
      const normalizedBefore = normalizedReasoning(candidate);
      if (sawThinkTag) {
        // Some relay/model combinations can emit: <think>x</think>x</think> answer.
        // Drop the duplicated reasoning leak, but keep unrelated text as visible answer content.
        pendingAfterThinkText = '';
        if (!normalizedBefore || normalizedBefore === lastClosedReasoning || lastClosedReasoning.startsWith(normalizedBefore)) {
          buffer = afterClose.replace(/^\s+/, '');
          return;
        }
        emitText(candidate);
        buffer = afterClose.replace(/^\s+/, '');
        return;
      }
      emitText(beforeClose);
    } else if (pendingAfterThinkText && sawThinkTag) {
      const normalizedPending = normalizedReasoning(pendingAfterThinkText);
      if (!normalizedPending || normalizedPending === lastClosedReasoning || lastClosedReasoning.startsWith(normalizedPending)) {
        pendingAfterThinkText = '';
        buffer = afterClose.replace(/^\s+/, '');
        return;
      }
      flushPendingAfterThinkText();
    }

    buffer = afterClose;
  };

  const parse = (final: boolean) => {
    while (buffer) {
      if (inThink) {
        const closeIdx = indexOfTag(buffer, CLOSE_TAG);
        if (closeIdx >= 0) {
          emitReasoning(buffer.slice(0, closeIdx));
          endReasoning();
          inThink = false;
          buffer = buffer.slice(closeIdx + CLOSE_TAG.length);
          continue;
        }

        const keep = final ? 0 : pendingTagPrefixLength(buffer, [CLOSE_TAG]);
        emitReasoning(buffer.slice(0, buffer.length - keep));
        buffer = buffer.slice(buffer.length - keep);
        if (final && buffer) {
          emitReasoning(buffer);
          buffer = '';
        }
        return;
      }

      const openIdx = indexOfTag(buffer, OPEN_TAG);
      const closeIdx = indexOfTag(buffer, CLOSE_TAG);

      if (closeIdx >= 0 && (openIdx < 0 || closeIdx < openIdx)) {
        consumeNormalModeCloseTag(closeIdx);
        continue;
      }

      if (openIdx >= 0) {
        emitNormalText(buffer.slice(0, openIdx));
        flushPendingAfterThinkText(true);
        sawThinkTag = true;
        inThink = true;
        buffer = buffer.slice(openIdx + OPEN_TAG.length);
        continue;
      }

      const keep = final ? 0 : pendingTagPrefixLength(buffer, [OPEN_TAG, CLOSE_TAG]);
      emitNormalText(buffer.slice(0, buffer.length - keep));
      buffer = buffer.slice(buffer.length - keep);
      return;
    }
  };

  return {
    feed(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      parse(false);
    },
    flush() {
      parse(true);
      if (inThink) {
        if (buffer) emitReasoning(buffer);
        buffer = '';
        inThink = false;
        endReasoning();
      } else {
        if (buffer) {
          emitNormalText(buffer);
          buffer = '';
        }
        flushPendingAfterThinkText(true);
      }
    },
  };
}
