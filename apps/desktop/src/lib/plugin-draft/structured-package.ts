import { PluginManifest } from '@lingfang/contract';
import { classifyBlockInfo, type StructuredBlock } from '@/lib/plugin-creator-protocol';
import type { DraftDiagnostic, DraftFile } from '@/lib/types';
import { cleanPathFrontend } from './manifest';

const MAX_PLUGIN_FILE_BYTES = 256 * 1024;
const MAX_PLUGIN_TOTAL_BYTES = 2 * 1024 * 1024;

export interface ParsedStructuredPackage {
  manifest: Partial<PluginManifest> | null; // 解析失败为 null
  files: DraftFile[]; // 同 path 后者覆盖
  notes: string; // notes 块拼接
  rawBlocks: StructuredBlock[]; // 原始块（诊断用）
  diagnostics: DraftDiagnostic[]; // schema stage 诊断
  status: 'ready' | 'partial' | 'invalid'; // 总体判定
  manifestJson: string | null; // 序列化的 manifest.json 内容
}

// 从 file 块 info string 提取 path：支持 path="..." / path='...' / 裸 token。
function extractFilePath(info: string): string | undefined {
  const trimmed = info.trim();
  const dbl = trimmed.match(/path\s*=\s*"([^"]*)"/);
  if (dbl) return dbl[1];
  const sgl = trimmed.match(/path\s*=\s*'([^']*)'/);
  if (sgl) return sgl[1];
  // 裸 token：取 file 关键字后的第一个非空白段。
  const token = trimmed.match(/^file\s+(\S+)$/);
  if (token) return token[1];
  return undefined;
}

// 用逐行扫描匹配 fenced code block，比纯正则更可控（围栏嵌套场景下取到下一个未被消费的结束围栏）。
// 处理三类：规范块（```info）、裸块（``` 无 info）、围栏嵌套（块内含 ``` 提前结束 → 剩余兜底）。
export function extractFencedBlocks(raw: string): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  const lines = raw.split('\n');
  // 字符偏移查表：lineOffsets[k] 为第 k 行在原文中的起始字符偏移（诊断用）。
  // 每行长度 + 1（换行符），与 split('\n') 后还原原文的偏移一致。
  const lineOffsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1;
  }
  let i = 0;
  // 起始围栏：行首 3+ 个反引号（允许前导空白），后跟可选 info string。
  const startRe = /^\s*(`{3,})(.*)$/;
  // 结束围栏：行首 3+ 个反引号，info 为空（CommonMark 规范：结束围栏不能有 info）。
  const endRe = /^\s*(`{3,})\s*$/;
  while (i < lines.length) {
    const startMatch = lines[i].match(startRe);
    if (!startMatch) { i++; continue; }
    const fence = startMatch[1];
    const info = startMatch[2].trim();
    const startLine = i;
    const contentLines: string[] = [];
    let closeLine = -1;
    let j = i + 1;
    // 寻找匹配的结束围栏：反引号数 >= 起始，且行内无 info。
    while (j < lines.length) {
      const endMatch = lines[j].match(endRe);
      if (endMatch && endMatch[1].length >= fence.length) { closeLine = j; break; }
      contentLines.push(lines[j]);
      j++;
    }
    if (closeLine === -1) {
      // 未找到结束围栏：视为截断，内容取到文末（围栏嵌套 / 流被切断）。
      // 标记 truncated，由 parseStructuredPackage 补 schema 诊断（design §3.2.2 步骤1）。
      blocks.push({
        kind: classifyBlockInfo(info),
        info,
        content: contentLines.join('\n'),
        start: lineOffsets[startLine] || 0,
        path: undefined,
        truncated: true,
      });
      break;
    }
    blocks.push({
      kind: classifyBlockInfo(info),
      info,
      content: contentLines.join('\n'),
      start: lineOffsets[startLine] || 0,
      path: undefined,
    });
    i = closeLine + 1;
  }
  return blocks;
}


// unknown 块候选归类：内容特征 → ui/index.html；其余 snippet-N。
// 设计 §3.2.2 步骤5：保证模型只输出裸代码块时也能拿到至少一个文件。
function classifyUnknownBlock(block: StructuredBlock, snippetCounter: { n: number }, hasEntry: boolean): { path: string; language?: string } {
  const lower = block.content.toLowerCase();
  const isHtml =
    /^html/.test(block.info) ||
    lower.includes('<html') ||
    lower.includes('<!doctype') ||
    lower.includes('<body');
  if (isHtml && !hasEntry) {
    return { path: 'ui/index.html', language: 'html' };
  }
  // 其余（含已知语言标识但非 html）按 snippet-N 命名。
  const idx = snippetCounter.n++;
  return { path: `snippet-${idx}` };
}

// 解析模型 stdout 文本为结构化插件包（design §3.2.2）。
// 纯函数：无副作用，确定性，可单测。
export function parseStructuredPackage(rawText: string): ParsedStructuredPackage {
  const diagnostics: DraftDiagnostic[] = [];
  const rawBlocks = extractFencedBlocks(rawText);
  // 截断块诊断（design §3.2.2 步骤1 / §6.3 风险点）：围栏嵌套或流被切断导致提前结束。
  for (const block of rawBlocks) {
    if (block.truncated) {
      diagnostics.push({ stage: 'schema', status: 'fail', message: `围栏可能被截断（块 ${block.kind} 未找到结束围栏）` });
    }
  }

  const notesParts: string[] = [];
  const fileMap = new Map<string, DraftFile>();
  const snippetCounter = { n: 0 };
  let manifestJson: string | null = null;
  let manifestObj: Partial<PluginManifest> | null = null;
  let manifestBlockCount = 0;
  let entryHint: string | undefined;

  // 第一轮：先收集 manifest 以确定 entry（unknown 块候选归类需要知道是否已有 entry）。
  for (const block of rawBlocks) {
    if (block.kind === 'manifest') {
      manifestBlockCount++;
      try {
        const obj = JSON.parse(block.content);
        manifestJson = block.content;
        const parsed = PluginManifest.safeParse(obj);
        if (parsed.success) {
          manifestObj = parsed.data;
          entryHint = parsed.data.entry;
        } else {
          // zod 校验失败：尝试保留可读字段供 buildLocalDraft 兜底补全。
          manifestObj = typeof obj === 'object' && obj ? (obj as Partial<PluginManifest>) : null;
          entryHint = typeof obj?.entry === 'string' ? obj.entry : undefined;
          diagnostics.push({
            stage: 'schema',
            status: 'fail',
            message: `manifest 校验失败：${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
          });
        }
      } catch (err) {
        manifestObj = null;
        diagnostics.push({
          stage: 'schema',
          status: 'fail',
          message: `manifest JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
  if (manifestBlockCount > 1) {
    diagnostics.push({ stage: 'schema', status: 'warn', message: `检测到 ${manifestBlockCount} 个 manifest 块，已采用最后一个` });
  }

  // 第二轮：file / notes / unknown 块。
  for (const block of rawBlocks) {
    if (block.kind === 'notes') {
      notesParts.push(block.content);
      continue;
    }
    if (block.kind === 'file') {
      const rawPath = extractFilePath(block.info);
      if (!rawPath) {
        diagnostics.push({ stage: 'schema', status: 'fail', message: 'file 块缺少 path，已丢弃' });
        continue;
      }
      const cleaned = cleanPathFrontend(rawPath);
      if (!cleaned.ok) {
        diagnostics.push({ stage: 'schema', status: 'fail', message: `文件路径非法（${cleaned.reason}）：${rawPath}` });
        continue;
      }
      fileMap.set(cleaned.value, { path: cleaned.value, content: block.content });
      continue;
    }
    if (block.kind === 'unknown') {
      const hasEntry = entryHint ? fileMap.has(entryHint) : false;
      const { path, language } = classifyUnknownBlock(block, snippetCounter, hasEntry);
      block.language = language;
      block.path = path;
      fileMap.set(path, { path, content: block.content });
    }
  }

  const files = Array.from(fileMap.values());
  const notes = notesParts.join('\n\n').trim();

  // 状态判定（字节预算检查后再最终确定）。
  let status: ParsedStructuredPackage['status'];
  if (!manifestObj) {
    status = 'invalid';
  } else {
    const entry = typeof manifestObj.entry === 'string' ? manifestObj.entry : undefined;
    if (entry && files.some((f) => f.path === entry)) {
      status = 'ready';
    } else {
      status = 'partial';
    }
  }

  // 字节预算检查（design §3.2.2 步骤7）：单文件 256KB / 总量 2MB 超限强制 invalid。
  let totalBytes = 0;
  let overLimit = false;
  for (const file of files) {
    const bytes = new TextEncoder().encode(file.content).length;
    if (bytes > MAX_PLUGIN_FILE_BYTES) {
      overLimit = true;
      diagnostics.push({ stage: 'schema', status: 'fail', message: `单文件超 256KB 限制：${file.path}` });
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
    overLimit = true;
    diagnostics.push({ stage: 'schema', status: 'fail', message: '插件包总大小超 2MB 限制' });
  }
  if (overLimit) status = 'invalid';

  return {
    manifest: manifestObj,
    files,
    notes,
    rawBlocks,
    diagnostics,
    status,
    manifestJson,
  };
}

// entry 文件缺失时生成兜底预览页（design §3.2.5 / B5）。
