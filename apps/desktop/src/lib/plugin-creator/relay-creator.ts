// relay-creator.ts —— relay 版插件创建器（替代已删除的 code_assistant CLI）。
//
// 设计：把"描述插件 → AI 生成"从本地 CLI 子进程改为调平台 relay（/api/relay/v1/chat/completions），
// 用 fast/premium 版本，扣团队灵石（relay 侧自动计费 + 注入系统提示词规则）。
//
// 协议：要求模型在回复中输出**一个 ```lingfang-plugin JSON 代码块**，结构为
//   { manifest: PluginManifest, files: [{ path, content }] }
// 本文件负责拼 systemPrompt、调 relay、解析代码块、校验产物。解析容错（模型可能加前后文）。
import { api, type ApiError } from '@/lib/api';

/** 一次创建请求的输入。 */
export interface CreatePluginInput {
  /** 用户对插件的 Natural-language 描述。 */
  prompt: string;
  /** 模型版本（fast/premium），默认 fast。 */
  tier?: 'fast' | 'premium';
  /** 可选：已生成的样例（引导模型）。 */
  examples?: string;
}

/** 校验后的插件 manifest（与后端 /api/plugins/upload 契约对齐，snake_case）。 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime_type: 'client' | 'nodejs' | 'python';
  entry: string;
  visibility: 'private' | 'team' | 'public';
  capabilities: { kind: string; reason?: string; risk?: string }[];
}

/** 解析出的插件包（待上传）。 */
export interface CreatedPluginPackage {
  manifest: PluginManifest;
  files: { path: string; content: string }[];
}

/** 创建器的系统提示词：约束模型只产出一个结构化 JSON 代码块。 */
const CREATOR_SYSTEM_PROMPT = `你是灵坊平台的插件生成器。用户会用自然语言描述一个插件，你需要生成一个完整可运行的插件包。

输出格式（严格遵守）：
- 只输出一个 \`\`\`lingfang-plugin 代码块，里面是一个合法 JSON 对象。
- 不要输出任何额外解释文字（代码块前后都不要）。
- JSON 结构：
  {
    "manifest": {
      "id": "<kebab-case 插件 id，仅字母数字与连字符>",
      "name": "<展示名>",
      "version": "0.1.0",
      "description": "<一句话描述>",
      "runtime_type": "client" | "nodejs" | "python",
      "entry": "<入口文件路径，client 通常 ui/index.html；nodejs 通常 index.js；python 通常 main.py>",
      "visibility": "team",
      "capabilities": [{ "kind": "ui.view", "reason": "<为何需要>", "risk": "low" }]
    },
    "files": [
      { "path": "<相对路径>", "content": "<文件全文>" }
    ]
  }

约束：
- client 类型：entry 必须是 ui/index.html，files 至少含该 HTML（可用内联 CSS/JS）。
- nodejs 类型：entry 为 index.js，files 含 package.json（若无 dependencies 用空对象）与 index.js。
- python 类型：entry 为 main.py，files 含 requirements.txt（可空）与 main.py。
- 文件路径只能是相对路径，禁止绝对路径、空段、. 或 .. 段。
- capabilities.kind 仅可取：ui.view / fs.read / fs.write / net.fetch / clipboard / llm.chat / image.generate / storage.kv / system.info / system.notify。
- 插件如需调用 AI，必须且只能用 sdk.llm.chat / sdk.image.generate（灵坊平台服务），禁止第三方接口。
- 单文件 < 256 KiB，总包 < 2 MiB，最多 80 个文件。
- 代码要完整可运行，不要省略或用占位符。`;

/** 调 relay 生成插件包。返回解析后的 {manifest, files}；失败抛错。 */
export async function createPlugin(input: CreatePluginInput): Promise<CreatedPluginPackage> {
  const tier = input.tier === 'premium' ? 'premium' : 'fast';
  const userContent = input.examples ? `${input.examples}\n\n——\n用户需求：${input.prompt}` : input.prompt;

  const res = await api<{ choices?: { message?: { content?: string } }[] }>(
    '/api/relay/v1/chat/completions',
    {
      method: 'POST',
      body: {
        model: tier,
        messages: [
          { role: 'system', content: CREATOR_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        stream: false,
        temperature: 0.4,
      },
    },
  );

  const content = res.choices?.[0]?.message?.content ?? '';
  const pkg = parsePackageBlock(content);
  if (!pkg) {
    throw new Error('AI 未返回可识别的插件包（缺少 ```lingfang-plugin 代码块）。请换个描述重试。');
  }
  return pkg;
}

/** 从模型回复中提取 ```lingfang-plugin JSON 代码块并解析。容错：取首个匹配。 */
export function parsePackageBlock(content: string): CreatedPluginPackage | null {
  const fenceMatch = content.match(/```lingfang-plugin\s*\n([\s\S]*?)```/i);
  const jsonText = fenceMatch?.[1] ?? extractBalancedJson(content);
  if (!jsonText) return null;

  let obj: { manifest?: unknown; files?: unknown };
  try {
    obj = JSON.parse(jsonText.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || !obj.manifest || !Array.isArray(obj.files)) return null;

  const manifest = validateManifest(obj.manifest);
  if (!manifest) return null;

  const files = (obj.files as { path: string; content: string }[])
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .filter((f) => isSafeRelativePath(f.path));
  if (files.length === 0) return null;

  // entry 必须存在于 files。
  if (!files.some((f) => f.path === manifest.entry)) return null;

  return { manifest, files };
}

/** 校验 AI 产出的 manifest 对象：必填字段 + runtime_type/visibility 白名单 + entry 默认值。 */
function validateManifest(raw: unknown): PluginManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!id || !name) return null;
  if (!/^[a-z0-9-]+$/.test(id)) return null; // kebab-case
  const runtimeType = m.runtime_type ?? m.runtimeType;
  if (runtimeType !== 'client' && runtimeType !== 'nodejs' && runtimeType !== 'python') return null;
  const visibility = m.visibility;
  if (visibility !== 'private' && visibility !== 'team' && visibility !== 'public') {
    // 缺省 team（后端默认）。
  }
  const entry = typeof m.entry === 'string' && m.entry.trim() ? m.entry.trim() : defaultEntry(runtimeType);
  const capabilities = Array.isArray(m.capabilities)
    ? (m.capabilities as unknown[]).filter((c) => c && typeof c === 'object' && typeof (c as Record<string, unknown>).kind === 'string') as PluginManifest['capabilities']
    : [];
  return {
    id,
    name,
    version: typeof m.version === 'string' ? m.version : '0.1.0',
    description: typeof m.description === 'string' ? m.description : '',
    runtime_type: runtimeType,
    entry,
    visibility: (visibility as PluginManifest['visibility']) ?? 'team',
    capabilities,
  };
}

function defaultEntry(runtimeType: 'client' | 'nodejs' | 'python'): string {
  if (runtimeType === 'nodejs') return 'index.js';
  if (runtimeType === 'python') return 'main.py';
  return 'ui/index.html';
}

/** 无代码块围栏时，尝试从裸文本里抠一个顶层 JSON 对象（兜底）。 */
function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 安全相对路径：禁止绝对/空段/./.. 。 */
function isSafeRelativePath(p: string): boolean {
  if (!p) return false;
  if (p.includes('\\') || /^[\\/]/.test(p)) return false;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  return true;
}

/** 把生成的包上传到团队云端（POST /api/plugins/upload）。 */
export async function uploadCreatedPlugin(pkg: CreatedPluginPackage, opts?: { priceCents?: number }) {
  return api('/api/plugins/upload', {
    method: 'POST',
    body: { manifest: pkg.manifest, files: pkg.files, priceCents: opts?.priceCents ?? 0 },
  });
}

export type { ApiError };
