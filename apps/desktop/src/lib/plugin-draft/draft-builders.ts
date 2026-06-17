import { PluginManifest } from '@lingfang/contract';
import type { DraftDiagnostic, DraftFile, DraftTurn, PluginDraft } from '@/lib/types';
import { buildFallbackEntryFile, defaultEntryForRuntime, FRONTEND_RUNTIME_TYPES, FRONTEND_VISIBILITIES, hasValidCapabilities, normalizeCapabilities, normalizeEnum, parseManifest, safePluginId } from './manifest';
import { cliSessionId, compactTurnSegments, extractCliText, type CliProbeResult, type TurnSegmentInput } from './session';
import { extractFencedBlocks, parseStructuredPackage } from './structured-package';

export function buildLocalDraft(input: {
  prompt: string;
  providerLabel: string;
  model: string;
  result: CliProbeResult;
}): PluginDraft {
  const output = extractCliText(input.result);
  const id = `local-${input.result.tool}-${Date.now()}`;
  const pluginId = safePluginId(input.prompt);
  const now = new Date().toISOString();

  // 协议解析（design §3.2.5）：把 CLI stdout 解析为结构化 manifest + 多文件 + notes + 诊断。
  const parsed = parseStructuredPackage(output);
  const parsedManifest = parsed.manifest;

  // CLI 字段优先 + 前端兜底补全（兼容模型少产字段的 partial 场景）。
  // 枚举字段用 normalizeEnum 收敛：非法值（如 'public'/'edge'）退回默认，避免穿透后端 400。
  // runtime_type 先行确定，entry 回退按 runtime 分流（python→main.py / nodejs→index.js / client→ui/index.html），
  // 修复 Python/Node 插件入口误判为 ui/index.html 的 bug。
  const runtimeType = normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, 'client') as PluginManifest['runtime_type'];
  const manifest = {
    id: parsedManifest?.id || pluginId,
    name: parsedManifest?.name || input.prompt.slice(0, 24) || '本地代码助手插件',
    version: parsedManifest?.version || '0.1.0',
    description: parsedManifest?.description || `由 ${input.providerLabel} 本地 CLI 生成的插件草稿`,
    runtime_type: runtimeType,
    entry: parsedManifest?.entry || defaultEntryForRuntime(runtimeType),
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, 'tenant') as 'private' | 'tenant',
    // 契约收敛：彻底消除字符串数组 bug（旧 :198 的 ['code-assistant']）。
    capabilities: normalizeCapabilities(parsedManifest?.capabilities),
  };

  // entry 缺失自动兜底 + warning（保证模型未产 entry 时仍有可运行文件）。
  // 兜底内容按 runtime 分流：python→main.py 骨架，nodejs→index.js 骨架，client→HTML 预览页。
  let files: DraftFile[] = [...parsed.files];
  const schemaDiagnostics: DraftDiagnostic[] = [...parsed.diagnostics];
  if (!files.find((file) => file.path === manifest.entry)) {
    const fallback = buildFallbackEntryFile(runtimeType, {
      notes: parsed.notes,
      manifestName: manifest.name,
      description: manifest.description,
    });
    files = [...files, { path: manifest.entry, content: fallback.content }];
    schemaDiagnostics.push({
      stage: 'schema',
      status: 'warn',
      message: `入口文件 ${manifest.entry} 缺失，已按 ${runtimeType} 类型生成兜底骨架`,
    });
  }
  // manifest.json 始终以收敛后的合法对象序列化，放在 files 首位。
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  // 状态判定（DRAFT-02 修复）：
  // - 无 manifest 输出 → fallbackStatus（与 success 联动：success+output→partial，否则 invalid）。
  // - manifest 解析成功 + 字节超限 → 保持 parse 的 invalid（parse 在字节超限时强制设 invalid）。
  //   此前三元把任何非 ready 的 parsed.status（含 invalid）一律折叠为 partial，丢失了 parse 层判定。
  // - 其余（ready/partial）→ 原样采用。
  const fallbackStatus = input.result.success && output ? 'partial' : 'invalid';
  const status = !parsedManifest
    ? fallbackStatus
    : parsed.status === 'ready' ? 'ready' : parsed.status;

  // schema stage 汇总诊断。
  const schemaStatus: DraftDiagnostic['status'] = parsed.status === 'ready' ? 'pass' : parsed.status === 'partial' ? 'warn' : 'fail';
  const schemaSummary = `结构化解析：${parsed.status}（manifest ${parsedManifest ? '已解析' : '缺失'}，文件 ${parsed.files.length}，notes ${parsed.notes ? '有' : '无'}）`;

  return {
    id,
    status,
    files,
    turns: [
      { role: 'user', content: input.prompt, at: now },
      // assistant 内容优先 notes（模型给用户的自然语言说明），其次 stdout 原文。
      buildAssistantTurn(parsed.notes || output || '本地 CLI 没有返回可展示内容。', now),
    ],
    diagnostics: [
      // 只保留用户关心的 schema 结果（成功/失败原因）；session/命令/transcript 等工程排障信息
      // 已在「分析」tab 的 SessionStatusPanel 展示，此处不再重复（避免诊断面板对普通用户太工程化）。
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(input.result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
    ],
  };
}

// === 方案A：从 sandbox 扫描结果构建插件草稿（claude 用 Write 工具写文件到 workspace） ===
//
// 与 buildLocalDraft 的差异：files 直接来自 Rust scan_workspace_files 扫描目录（非 stdout 围栏块解析），
// manifest 从扫描结果里的 manifest.json 内容解析（claude 真实写盘，比强制纯文本围栏块稳定）。
//
// 调用时机：CLI exit 后，finalizeSession 先调 scanWorkspaceFiles，若返回 manifest.json + 文件即走本函数，
// 不再走 stdout 围栏块解析（claude 写了文件就不再产围栏块，stdout 解析会判 invalid）。
//
// 返回值约定：
// - 扫描到 manifest.json 且至少一个文件 → 完整 PluginDraft（status=ready/partial）。
// - 空 sandbox 或无 manifest.json → 返回 null（调用方据回退到对话态 / stdout 围栏块解析）。

export interface SbFile {
  path: string;
  content: string;
}

export function buildDraftFromSandboxFiles(input: {
  prompt: string;
  providerLabel: string;
  model: string;
  result: CliProbeResult;
  files: SbFile[];
}): PluginDraft | null {
  // 无 manifest.json → 无法识别为插件包（claude 未写文件或纯对话），返回 null 让调用方回退。
  const manifestFile = input.files.find((file) => file.path === 'manifest.json');
  if (!manifestFile) return null;

  const id = `local-${input.result.tool}-${Date.now()}`;
  const pluginId = safePluginId(input.prompt);
  const now = new Date().toISOString();

  // 从 manifest.json 内容解析 manifest（claude 写盘的原始 JSON，可能含字段缺失 → 兜底补全）。
  // 复用 parseStructuredPackage 同款兜底策略（枚举 normalizeEnum + capabilities normalizeCapabilities）。
  let parsedManifest: Partial<PluginManifest> | null = null;
  const schemaDiagnostics: DraftDiagnostic[] = [];
  try {
    const obj = JSON.parse(manifestFile.content);
    const zodParsed = PluginManifest.safeParse(obj);
    if (zodParsed.success) {
      parsedManifest = zodParsed.data;
    } else {
      // zod 校验失败：保留可读字段供兜底补全，并补 schema 诊断。
      parsedManifest = typeof obj === 'object' && obj ? (obj as Partial<PluginManifest>) : null;
      schemaDiagnostics.push({
        stage: 'schema',
        status: 'fail',
        message: `manifest 校验失败：${zodParsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
      });
    }
  } catch (err) {
    schemaDiagnostics.push({
      stage: 'schema',
      status: 'fail',
      message: `manifest JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // CLI 字段优先 + 前端兜底补全（与 buildLocalDraft 同款策略，保证少字段 partial 场景仍可用）。
  // runtime_type 先行，entry 回退按 runtime 分流（python→main.py / nodejs→index.js / client→ui/index.html）。
  const runtimeType = normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, 'client') as PluginManifest['runtime_type'];
  const manifest = {
    id: parsedManifest?.id || pluginId,
    name: parsedManifest?.name || input.prompt.slice(0, 24) || '本地代码助手插件',
    version: parsedManifest?.version || '0.1.0',
    description: parsedManifest?.description || `由 ${input.providerLabel} 本地 CLI 生成的插件草稿`,
    runtime_type: runtimeType,
    entry: parsedManifest?.entry || defaultEntryForRuntime(runtimeType),
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, 'tenant') as 'private' | 'tenant',
    capabilities: normalizeCapabilities(parsedManifest?.capabilities),
  };

  // files：扫描结果去掉旧的 manifest.json（claude 写盘的原始 JSON 可能字段不全），
  // 重新塞入收敛后的合法 manifest.json（放首位，与 buildLocalDraft 同款约定）。
  const scanFilesExceptManifest = input.files.filter((file) => file.path !== 'manifest.json');
  let files: DraftFile[] = [...scanFilesExceptManifest];

  // entry 缺失自动兜底（claude 偶尔只写 manifest.json 漏 entry 文件），按 runtime 分流兜底内容。
  // entryMissing 标记原始扫描是否缺失 entry（决定 status：原始缺失则 partial，即使兜底页注入也不判 ready）。
  const entryMissing = !scanFilesExceptManifest.some((file) => file.path === manifest.entry);
  if (entryMissing) {
    const fallback = buildFallbackEntryFile(runtimeType, {
      manifestName: manifest.name,
      description: manifest.description,
    });
    files = [...files, { path: manifest.entry, content: fallback.content }];
    schemaDiagnostics.push({
      stage: 'schema',
      status: 'warn',
      message: `入口文件 ${manifest.entry} 缺失，已按 ${runtimeType} 类型生成兜底骨架`,
    });
  }
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  // 状态判定：有 manifest 且原始扫描含 entry 文件 → ready；entry 缺失（兜底页注入）或 manifest 解析失败 → partial。
  const status: PluginDraft['status'] = parsedManifest && !entryMissing ? 'ready' : 'partial';

  const schemaStatus: DraftDiagnostic['status'] = status === 'ready' ? 'pass' : 'warn';
  const schemaSummary = `sandbox 扫描：${status}（manifest ${parsedManifest ? '已解析' : '兜底'}，扫描文件 ${input.files.length}）`;

  return {
    id,
    status,
    files,
    turns: [
      { role: 'user', content: input.prompt, at: now },
      // assistant 内容优先用 stdout（claude 写完文件后给用户的自然语言说明），其次固定文案。
      buildAssistantTurn(
        extractCliText(input.result) || '本地代码助手已把插件文件写入工作目录。',
        now,
      ),
    ],
    diagnostics: [
      // 只保留用户关心的 schema 结果（成功/失败原因）；session/命令/transcript 等工程排障信息
      // 已在「分析」tab 的 SessionStatusPanel 展示，此处不再重复（避免诊断面板对普通用户太工程化）。
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(input.result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
    ],
  };
}

export function normalizeTurns(turns?: DraftTurn[]): DraftTurn[] {
  const out: DraftTurn[] = [];
  for (const turn of turns || []) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role && last.content === turn.content) continue;
    out.push(turn);
  }
  return out;
}

// === design §3.1.2 / §3.4.1：对话优先 gate 与纯对话态草稿（AC1 核心） ===
//
// 这组纯函数解耦「对话」与「插件创建」：
// - hasStructuredBlocks 探测产出是否含 manifest/file 块（gate，决定是否自动解析为草稿）。
// - makeConversationTurn / mergeConversationTurn 产出「纯对话态」草稿（无 files，仅 turns），
//   使「你好」这类闲聊不再被判 invalid、不再强制弹详情面板。
//
// 纯对话态草稿约定 status='generating'（STATUS_LABEL 已有此键），绝不取 'invalid'
// （否则触发右侧 destructive Badge + 预览 disabled，违背 AC1）。

// 探测产出是否含结构化块（manifest 或 file）。复用 extractFencedBlocks，严格只认协议块：
// 纯文本 / 只有 unknown 代码块（如裸 ```js）→ false；含 manifest 或 file 块 → true。
export function hasStructuredBlocks(rawText: string): boolean {
  const blocks = extractFencedBlocks(rawText);
  return blocks.some((b) => b.kind === 'manifest' || b.kind === 'file');
}

// 生成单个纯对话 turn（user + assistant 一对）。
// 与 makeConversationDraft/mergeConversationTurn 的差异：本函数仅产出 turn 数组，
// 供调用方按需拼装（如 finalizeSession 纯对话态累积）。
export function makeConversationTurn(
  userPrompt: string,
  assistantText: string,
  segments: TurnSegmentInput[] = [],
): DraftTurn[] {
  const now = new Date().toISOString();
  return [
    { role: 'user', content: userPrompt, at: now },
    buildAssistantTurn(assistantText, now, segments),
  ];
}

// 首轮纯对话态草稿：无 files/manifest，仅 turns=[u,a]，status='chat'（已完成对话，非"生成中"）。
export function makeConversationDraft(
  userPrompt: string,
  assistantText: string,
  segments: TurnSegmentInput[] = [],
): PluginDraft {
  return {
    id: `conversation-${Date.now()}`,
    status: 'chat',
    files: [],
    turns: makeConversationTurn(userPrompt, assistantText, segments),
    diagnostics: [],
  };
}

// 追问纯对话态：在既有 draft 上累积 turns（normalizeTurns 去重），files 保持空。
// prev.id 保持稳定（同一对话跨轮，不新开草稿）。
export function mergeConversationTurn(
  prev: PluginDraft,
  userPrompt: string,
  assistantText: string,
): PluginDraft {
  const now = new Date().toISOString();
  return {
    ...prev,
    status: 'chat',
    files: prev.files,
    turns: normalizeTurns([
      ...prev.turns,
      { role: 'user', content: userPrompt, at: now },
      buildAssistantTurn(assistantText, now),
    ]),
    diagnostics: prev.diagnostics,
  };
}

function buildAssistantTurn(text: string, at: string, segments: TurnSegmentInput[] = []): DraftTurn {
  const content = text || '本地 CLI 没有返回可展示内容。';
  const cleaned = compactTurnSegments(segments).filter((segment) => segment.text.trim());
  if (!cleaned.length) return { role: 'assistant', content, at };
  return { role: 'assistant', content, at, segments: cleaned };
}

export function withLastAssistantSegments(draft: PluginDraft, segments: TurnSegmentInput[]): PluginDraft {
  const cleaned = compactTurnSegments(segments).filter((segment) => segment.text.trim());
  if (!cleaned.length) return draft;
  for (let index = draft.turns.length - 1; index >= 0; index--) {
    if (draft.turns[index].role !== 'assistant') continue;
    const turns = draft.turns.map((turn, turnIndex) => (
      turnIndex === index ? { ...turn, segments: cleaned } : turn
    ));
    return { ...draft, turns };
  }
  return draft;
}

// design §3.3.6 (e)：追问草稿合并——在既有 draft 上累积 turns，files/manifest 用追问产出（R2 解析）覆盖迭代，
// R2 未产出时兜底保留 prev.files（保证追问即使结构化失败也能累积对话、不丢上轮文件）。
// prev.id 保持稳定（同一插件跨轮迭代，不新开草稿）。
export function mergeFollowupDraft(
  prev: PluginDraft,
  result: CliProbeResult,
  prompt: string,
): PluginDraft {
  const output = extractCliText(result);
  const now = new Date().toISOString();

  // 追问产出重新解析（R2 parseStructuredPackage 已存在）；失败时 parsed.files 为空，兜底 prev。
  const parsed = parseStructuredPackage(output);
  const parsedManifest = parsed.manifest;

  // manifest 沿用 prev 的 id/name（迭代不换插件），仅用追问产出补全可变字段。
  const prevManifest = parseManifest(prev.files);
  // runtime_type 先行（追问产出优先，回退 prev），entry/兜底按 runtime 分流。
  const runtimeType = normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, prevManifest.runtime_type as string) as PluginManifest['runtime_type'];
  const manifest = {
    id: parsedManifest?.id || prevManifest.id,
    name: parsedManifest?.name || prevManifest.name,
    version: parsedManifest?.version || prevManifest.version,
    description: parsedManifest?.description || prevManifest.description,
    runtime_type: runtimeType,
    // entry：追问产出优先，回退 prev.entry（prev 已按 runtime 分流过），最后按当前 runtime 兜底。
    entry: parsedManifest?.entry || prevManifest.entry || defaultEntryForRuntime(runtimeType),
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, prevManifest.visibility as string) as 'private' | 'tenant',
    // 修复 DRAFT-01：此前 capabilities 写成 normalizeCapabilities(parsedManifest?.capabilities)，
    // 不参考 prevManifest.capabilities。normalizeCapabilities 在收到 undefined/[]/非法数组时一律兜底为
    // [FALLBACK_CAPABILITY]（单 code-assistant.run）。追问只产 file 块无 manifest 块（codex/opencode 伪多轮常见）
    // 时 prevManifest.capabilities 被整体丢弃，多能力插件静默降级为单能力。
    // 与 entry/runtime_type/visibility 同款语义：parsed 合法非空才覆盖，否则透传 prev。
    capabilities: hasValidCapabilities(parsedManifest?.capabilities)
      ? normalizeCapabilities(parsedManifest?.capabilities)
      : prevManifest.capabilities,
  };

  // files：追问产出非空则覆盖（R2 迭代），否则保留 prev.files（兜底，design §3.3.6 风险点 RISK8）。
  let files: DraftFile[];
  const schemaDiagnostics: DraftDiagnostic[] = [...parsed.diagnostics];
  if (parsed.files.length > 0) {
    files = [...parsed.files];
    if (!files.find((file) => file.path === manifest.entry)) {
      const fallback = buildFallbackEntryFile(runtimeType, {
        notes: parsed.notes,
        manifestName: manifest.name,
        description: manifest.description,
      });
      files = [...files, { path: manifest.entry, content: fallback.content }];
      schemaDiagnostics.push({ stage: 'schema', status: 'warn', message: `入口文件 ${manifest.entry} 缺失，已按 ${runtimeType} 类型生成兜底骨架` });
    }
  } else {
    // R2 未产出结构化文件：保留上轮文件，标记 partial。
    files = prev.files.filter((file) => file.path !== 'manifest.json');
  }
  // manifest.json 始终以收敛后的合法对象序列化，放 files 首位。
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  // 状态：追问成功（有结构化产出或 success）→ ready/partial；完全无输出 → partial（保留可用态，不判 invalid）。
  // DRAFT-05 修复：此前三元 (result.success || output ? 'partial' : 'partial') 两支同值（死分支）。
  // 简化为单一 'partial'；若未来需把「完全无输出」改为 invalid，再展开为独立分支并补 spec。
  const status: PluginDraft['status'] = parsed.status === 'ready' ? 'ready' : 'partial';

  const schemaStatus: DraftDiagnostic['status'] = parsed.status === 'ready' ? 'pass' : parsed.status === 'partial' ? 'warn' : 'fail';
  const schemaSummary = `追问解析：${parsed.status}（manifest ${parsedManifest ? '已解析' : '缺失'}，文件 ${parsed.files.length}，notes ${parsed.notes ? '有' : '无'}）`;

  return {
    ...prev,
    status,
    files,
    turns: normalizeTurns([
      ...prev.turns,
      { role: 'user', content: prompt, at: now },
      buildAssistantTurn(parsed.notes || output || '本地 CLI 没有返回可展示内容。', now),
    ]),
    diagnostics: [
      ...prev.diagnostics,
      { stage: 'local-cli', status: result.success ? 'pass' : 'fail', message: `追问 ${cliSessionId(result) || '未返回 session'}` },
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
    ],
  };
}

// 方案A 追问合并：与 mergeFollowupDraft 同款语义，但 files 数据源改为 sandbox 扫描结果（非 stdout 围栏块）。
// 调用时机：追问 CLI exit 后，finalizeSession 先调 scanWorkspaceFiles；返回 manifest.json 即走本函数，
// 否则回退到 mergeFollowupDraft（stdout 围栏块解析）或对话态。
// prev.id 保持稳定（同一插件跨轮迭代，不新开草稿）。
export function mergeFollowupDraftWithSandbox(
  prev: PluginDraft,
  result: CliProbeResult,
  prompt: string,
  sbFiles: SbFile[],
): PluginDraft {
  const output = extractCliText(result);
  const now = new Date().toISOString();

  // 从 sandbox 扫描的 manifest.json 解析 manifest（claude 真实写盘）。
  const manifestFile = sbFiles.find((file) => file.path === 'manifest.json');
  let parsedManifest: Partial<PluginManifest> | null = null;
  if (manifestFile) {
    try {
      const obj = JSON.parse(manifestFile.content);
      parsedManifest = typeof obj === 'object' && obj ? (obj as Partial<PluginManifest>) : null;
    } catch {
      parsedManifest = null;
    }
  }

  // manifest 沿用 prev 的 id/name（迭代不换插件），仅用追问产出补全可变字段。
  const prevManifest = parseManifest(prev.files);
  // runtime_type 先行（追问产出优先，回退 prev），entry/兜底按 runtime 分流。
  const runtimeType = normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, prevManifest.runtime_type as string) as PluginManifest['runtime_type'];
  const manifest = {
    id: parsedManifest?.id || prevManifest.id,
    name: parsedManifest?.name || prevManifest.name,
    version: parsedManifest?.version || prevManifest.version,
    description: parsedManifest?.description || prevManifest.description,
    runtime_type: runtimeType,
    entry: parsedManifest?.entry || prevManifest.entry || defaultEntryForRuntime(runtimeType),
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, prevManifest.visibility as string) as 'private' | 'tenant',
    // 修复 DRAFT-01：与 mergeFollowupDraft 同款修复——parsed 合法非空才覆盖，否则透传 prev，
    // 避免追问未重发完整 manifest 时 prevManifest.capabilities 被整体丢弃（多能力插件降级为单能力）。
    capabilities: hasValidCapabilities(parsedManifest?.capabilities)
      ? normalizeCapabilities(parsedManifest?.capabilities)
      : prevManifest.capabilities,
  };

  // files：sandbox 扫描结果非空则覆盖（迭代），否则保留 prev.files（兜底，追问未改文件时维持上轮）。
  const scanFilesExceptManifest = sbFiles.filter((file) => file.path !== 'manifest.json');
  let files: DraftFile[];
  let status: PluginDraft['status'];
  const schemaDiagnostics: DraftDiagnostic[] = [];
  if (scanFilesExceptManifest.length > 0) {
    files = [...scanFilesExceptManifest];
    // 原始扫描是否含 entry（决定 ready/partial，兜底页注入不算）。
    const entryMissing = !scanFilesExceptManifest.some((file) => file.path === manifest.entry);
    if (entryMissing) {
      const fallback = buildFallbackEntryFile(runtimeType, {
        manifestName: manifest.name,
        description: manifest.description,
      });
      files = [...files, { path: manifest.entry, content: fallback.content }];
      schemaDiagnostics.push({ stage: 'schema', status: 'warn', message: `入口文件 ${manifest.entry} 缺失，已按 ${runtimeType} 类型生成兜底骨架` });
    }
    // sandbox 有源码产出且原始含 entry → ready；entry 缺失（兜底页注入）→ partial。
    status = parsedManifest && !entryMissing ? 'ready' : 'partial';
  } else {
    // sandbox 仅 manifest.json 无源码文件：保留上轮文件，标记 partial（追问未改源码，保守标记）。
    files = prev.files.filter((file) => file.path !== 'manifest.json');
    status = 'partial';
  }
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  const schemaStatus: DraftDiagnostic['status'] = status === 'ready' ? 'pass' : 'warn';
  const schemaSummary = `追问 sandbox 扫描：${status}（manifest ${parsedManifest ? '已解析' : '沿用上轮'}，扫描文件 ${sbFiles.length}）`;

  return {
    ...prev,
    status,
    files,
    turns: normalizeTurns([
      ...prev.turns,
      { role: 'user', content: prompt, at: now },
      buildAssistantTurn(output || '本地代码助手已更新插件文件。', now),
    ]),
    diagnostics: [
      ...prev.diagnostics,
      { stage: 'local-cli', status: result.success ? 'pass' : 'fail', message: `追问 ${cliSessionId(result) || '未返回 session'}` },
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
    ],
  };
}
