export interface ToolCardView {
  // 工具名（input_json_delta 增量无 name，聚合时沿用同卡片的已知 name）。
  name: string;
  // 累积的入参 JSON 文本（可能仍是不完整片段，渲染兜底按字符串展示）。
  inputText: string;
}

// AskUserQuestion 单问题模型（对齐 claude AskUserQuestion 工具的 questions[].options[]）。
export interface AskUserOption {
  label: string;
  description?: string;
}
export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserOption[];
}

// 从一段 tool 流文本中解析出 (name, inputJson 片段)。
// 格式约定（spawn_reader 产出）：
//   - content_block_start：有 name 头，形如 "Read {json}" 或裸 "Read"（input 为空时）。
//   - input_json_delta：name 为空，文本为原始 partial_json 片段（可能不以 { 开头，如 ".ts"}" 续片）。
// 判定 name 头的稳健规则：必须形如「标识符 + 至少一个空白 + 余下」才认作 name 头；
// 否则一律视为纯 input 片段（name 为空），避免把 ".ts"}" 这类续片误判为新工具名。
export function splitToolText(text: string): { name: string; jsonPart: string } {
  const trimmed = text.trimStart();
  if (!trimmed) return { name: '', jsonPart: '' };
  // 标识符头（字母/下划线开头）+ 空白 + 余下非空 → 拆 name。
  const headerMatch = trimmed.match(/^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/);
  if (headerMatch) {
    return { name: headerMatch[1], jsonPart: headerMatch[2].trim() };
  }
  // 纯标识符头无余下（content_block_start 的空 input，如裸 "Read"）：仅当整体是单个标识符时认作 name。
  const bareMatch = trimmed.match(/^([A-Za-z_]\w*)$/);
  if (bareMatch) {
    return { name: bareMatch[1], jsonPart: '' };
  }
  // 其余（{json、续片 .ts"} 等）：name 为空，整体当 input 片段。
  return { name: '', jsonPart: trimmed };
}

// 把 tool 流片段数组聚合为工具卡片视图（按到达顺序，input 累积同名/相邻卡片）。
// 聚合策略：遇到带 name 的片段开启新卡片（name 非空）；无 name 的片段 append 到最近一张卡片的 input。
// 首片无 name（极少见）时建一张空名卡片兜底。
export function aggregateToolCards(segments: string[]): ToolCardView[] {
  const cards: ToolCardView[] = [];
  for (const seg of segments) {
    const { name, jsonPart } = splitToolText(seg);
    if (name) {
      cards.push({ name, inputText: jsonPart });
    } else if (cards.length) {
      // 纯 input 增量：拼到最近一张卡片（content_block_start 后跟若干 input_json_delta）。
      cards[cards.length - 1].inputText += jsonPart;
    } else if (jsonPart) {
      // 兜底：无 name 头却有 input（异常形态），建空名卡片承载。
      cards.push({ name: '', inputText: jsonPart });
    }
  }
  return cards;
}

// 从工具卡片列表中提取所有 AskUserQuestion 的 questions（R4 问题卡片数据源）。
// inputText 可能是不完整 JSON：解析失败静默跳过（等后续增量补全后下一帧再解析）。
// 成功解析且含 questions 数组才产出，避免普通工具调用被误判为提问。
//
// 注意（DRAFT-03 / STREAM-01 修复）：本函数返回扁平化的问题数组，长度 = 所有 AskUserQuestion
// 卡片的有效问题总数（单卡多问时 > 卡片数），与输入 cards 的下标不对齐。
// 消费方（例如 AssistantChat 的工具块）不应再按下标取值——改用 extractAskUserQuestionsForCard，
// 按卡片就地解析该卡片承载的 questions，消除下标错配与单卡多问丢问的双重缺陷。
export function extractAskUserQuestions(cards: ToolCardView[]): AskUserQuestion[] {
  const out: AskUserQuestion[] = [];
  for (const card of cards) {
    if (card.name !== 'AskUserQuestion') continue;
    if (!card.inputText) continue;
    try {
      const parsed = JSON.parse(card.inputText) as { questions?: unknown };
      if (Array.isArray(parsed.questions)) {
        for (const q of parsed.questions) {
          if (q && typeof q === 'object') {
            const question = typeof (q as { question?: unknown }).question === 'string'
              ? String((q as { question?: string }).question)
              : '';
            const header = typeof (q as { header?: unknown }).header === 'string'
              ? String((q as { header?: string }).header)
              : undefined;
            const rawOptions = (q as { options?: unknown }).options;
            const options: AskUserOption[] = Array.isArray(rawOptions)
              ? rawOptions
                  .map((o) => {
                    if (typeof o === 'string') return { label: o } as AskUserOption;
                    if (o && typeof o === 'object') {
                      const label = (o as { label?: unknown }).label;
                      const description = (o as { description?: unknown }).description;
                      return {
                        label: typeof label === 'string' ? label : String(label ?? ''),
                        description: typeof description === 'string' ? description : undefined,
                      } as AskUserOption;
                    }
                    return null;
                  })
                  .filter((o): o is AskUserOption => Boolean(o && o.label))
              : [];
            // 仅保留有可选项的问题（2-4 项约定，但这里宽松收集，渲染层不强制上限）。
            if (question && options.length) {
              out.push({ question, header, options });
            }
          }
        }
      }
    } catch {
      // input 仍在累积中（片段 JSON），跳过等下一帧。
    }
  }
  return out;
}

// DRAFT-03 / STREAM-01 修复：按单张卡片就地解析其承载的 AskUserQuestion questions。
// 返回值与该卡片 1:1 对齐，不再受其它卡片（如前置的 Read/Write）下标错配影响，
// 且天然支持「单卡多问」（Claude AskUserQuestion 工具 questions 字段官方 1-4 项数组）。
// 卡片非 AskUserQuestion 或解析失败时返回空数组（普通工具渲染由输出块渲染层按 card.name 判定兜底）。
export function extractAskUserQuestionsForCard(card: ToolCardView): AskUserQuestion[] {
  if (card.name !== 'AskUserQuestion' || !card.inputText) return [];
  const out: AskUserQuestion[] = [];
  try {
    const parsed = JSON.parse(card.inputText) as { questions?: unknown };
    if (!Array.isArray(parsed.questions)) return [];
    for (const q of parsed.questions) {
      if (!q || typeof q !== 'object') continue;
      const question = typeof (q as { question?: unknown }).question === 'string'
        ? String((q as { question?: string }).question)
        : '';
      const header = typeof (q as { header?: unknown }).header === 'string'
        ? String((q as { header?: string }).header)
        : undefined;
      const rawOptions = (q as { options?: unknown }).options;
      const options: AskUserOption[] = Array.isArray(rawOptions)
        ? rawOptions
            .map((o) => {
              if (typeof o === 'string') return { label: o } as AskUserOption;
              if (o && typeof o === 'object') {
                const label = (o as { label?: unknown }).label;
                const description = (o as { description?: unknown }).description;
                return {
                  label: typeof label === 'string' ? label : String(label ?? ''),
                  description: typeof description === 'string' ? description : undefined,
                } as AskUserOption;
              }
              return null;
            })
            .filter((o): o is AskUserOption => Boolean(o && o.label))
        : [];
      if (question && options.length) {
        out.push({ question, header, options });
      }
    }
  } catch {
    // input 仍在累积中（片段 JSON），跳过等下一帧。
  }
  return out;
}

// 把任意工具卡片的 input 文本安全格式化为可展示字符串：
// 能 JSON.parse 则 pretty print，否则原样返回（增量未闭合场景兜底）。
export function formatToolInput(inputText: string): string {
  const trimmed = inputText.trim();
  if (!trimmed) return '';
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}
