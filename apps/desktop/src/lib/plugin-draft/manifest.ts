import { CapabilityKind, RuntimeType, type CapabilityKind as CapabilityKindType, type PluginCapability } from '@lingfang/contract';
import type { DraftDiagnostic, DraftFile, LoadedPlugin } from '@/lib/types';

const LOCAL_DRAFT_ENTRY = 'ui/index.html';

/**
 * 按 runtime_type 返回默认入口文件（修复 Python/Node 入口误判为 ui/index.html 的 bug）。
 * - python → main.py（独立 venv 进程入口，PRD 需求 5）
 * - nodejs → index.js（pnpm start 入口，PRD 需求 7）
 * - client / 未知 → ui/index.html（软件内 iframe，PRD 需求 8）
 *
 * 此前 entry 缺失时一律回退 ui/index.html（LOCAL_DRAFT_ENTRY），导致 Python 插件挂着 HTML 入口 +
 * 被补一个 HTML 兜底页，运行时找不到 main.py 报错。现按 runtime 分流，与 start_plugin 的入口解析对齐。
 */
export function defaultEntryForRuntime(runtimeType: string | undefined): string {
  switch (runtimeType) {
    case 'python':
      return 'main.py';
    case 'nodejs':
      return 'index.js';
    case 'client':
    default:
      return LOCAL_DRAFT_ENTRY;
  }
}

/**
 * entry 缺失时生成的兜底入口文件内容（按 runtime_type 分流）。
 * - client → HTML 兜底预览页（buildFallbackEntryHtml，原有行为）
 * - python → main.py 最小可运行骨架（打印一行，用户可见进程跑起来）
 * - nodejs → index.js 最小骨架
 * 这样即便 AI 未产入口，scan 判 ready 且运行时不崩（与 defaultEntryForRuntime 配套）。
 */
export function buildFallbackEntryFile(runtimeType: string | undefined, meta: { notes?: string; manifestName: string; description?: string }): { content: string; language: string } {
  switch (runtimeType) {
    case 'python':
      return {
        content: `# 灵坊工作台 Python 插件入口（自动生成的骨架）\n# 请替换为你的实际逻辑\nimport sys\n\n\ndef main() -> None:\n    print('插件已启动：' + ${JSON.stringify(meta.manifestName)}, file=sys.stdout)\n    # TODO: 在此实现插件逻辑\n\n\nif __name__ == '__main__':\n    main()\n`,
        language: 'python',
      };
    case 'nodejs':
      return {
        content: `// 灵坊工作台 Node 插件入口（自动生成的骨架）\n// 请替换为你的实际逻辑\nconsole.log('插件已启动：' + ${JSON.stringify(meta.manifestName)});\n// TODO: 在此实现插件逻辑\n`,
        language: 'javascript',
      };
    case 'client':
    default:
      return { content: buildFallbackEntryHtml(meta), language: 'html' };
  }
}

export function safePluginId(input: string) {
  // plugin_id \u5fc5\u987b\u7eaf ASCII\uff08Rust sanitize_plugin_id \u4ec5\u5141\u8bb8 [A-Za-z0-9_-]\uff09\u3002
  // \u975e ASCII \u5b57\u7b26\uff08\u542b\u4e2d\u6587\uff09\u9010\u4e2a\u8f6c base36 \u7f16\u7801\uff0c\u4fdd\u8bc1\u5408\u6cd5\u4e14\u53ef\u9006\u3002
  const ascii = input.replace(/[^\x20-\x7e]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code > 255 ? `u${code.toString(36)}` : `x${code.toString(36)}`;
  });
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'plugin';
}
const FRONTEND_CAPABILITY_KINDS = new Set<CapabilityKindType>(CapabilityKind.options);

// 合法 risk 取值（前端镜像后端 plugin-package.ts CapabilityRisk；契约 plugin.ts:16）。
const FRONTEND_CAPABILITY_RISKS = new Set(['none', 'low', 'medium', 'high']);

// 兜底能力：kind 必须命中白名单（绝不裸 code-assistant）。
// 本地代码助手执行属中等风险，reason 说明产出端兜底语义。
const FALLBACK_CAPABILITY = {
  kind: 'code-assistant.run' as const,
  reason: '本地代码助手执行',
  risk: 'medium' as const,
  requires_admin: false,
};

// 前端版 cleanPath：与后端 plugin-package.ts:61-69 cleanPath 行为对齐，产出端前置收敛。
// 与后端不同：不 throw，返回 discriminated union，把非法 path 记进 diagnostics 而非中断解析（容错目标）。
export function cleanPathFrontend(value: string): { ok: true; value: string } | { ok: false; reason: string } {
  const path = String(value || '').trim().replace(/\\/g, '/');
  if (!path) return { ok: false, reason: '插件文件路径不能为空' };
  if (path.startsWith('/') || path.startsWith('~') || /^[a-zA-Z]:\//.test(path)) {
    return { ok: false, reason: '插件文件路径不能是绝对路径' };
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { ok: false, reason: '插件文件路径不能包含空段或 ..' };
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    return { ok: false, reason: '插件文件路径不能包含隐藏系统路径' };
  }
  return { ok: true, value: path };
}

// 契约收敛：把任意形态的 capabilities 规范化为合法对象数组。
// 设计要点：合法对象数组（全部 kind 在白名单）→ map 规范化；否则整体兜底 [fallback]。
// 关键回归点：绝不兜底为裸 code-assistant（白名单外，会被后端 400 拒绝）。
export function normalizeCapabilities(parsed: unknown, fallback: PluginCapability = FALLBACK_CAPABILITY): PluginCapability[] {
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(
    (c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && typeof c.kind === 'string' && FRONTEND_CAPABILITY_KINDS.has(c.kind as CapabilityKindType),
  )) {
    return parsed.map((c) => {
      const risk = typeof c.risk === 'string' && FRONTEND_CAPABILITY_RISKS.has(c.risk) ? c.risk : 'low';
      const base: PluginCapability = {
        kind: c.kind as CapabilityKindType,
        reason: typeof c.reason === 'string' ? c.reason : '',
        risk: risk as PluginCapability['risk'],
        requires_admin: Boolean(c.requires_admin),
      };
      // scope 仅在显式提供时透传（与后端 plugin-package.ts:112 行为一致）。
      return c.scope === undefined ? base : { ...base, scope: c.scope as Record<string, unknown> };
    });
  }
  // 退化形态（字符串数组 / 部分非法 / 空数组 / 非数组）：整体兜底。
  return [fallback];
}

// 合法 runtime_type（前端镜像契约 RuntimeType；后端 plugin-package.ts:81-82 严格校验）。
export const FRONTEND_RUNTIME_TYPES = new Set<string>(RuntimeType.options);

// 合法 visibility（前端镜像后端 plugin-package.ts:83-84）。
export const FRONTEND_VISIBILITIES = new Set(['private', 'tenant']);

// 收敛枚举字段：合法值原样采用，非法值（含 falsy）退回 fallback；
// DRAFT-04 修复：若 fallback 本身不在白名单（磁盘脏值经 parseManifest 透传为 prevManifest.runtime_type/visibility），
// 退回白名单首个允许值，避免脏值继续传播到新写出的 manifest.json（最终被后端 normalizePluginPackage 400 拒绝）。
export function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  if (typeof value === 'string' && allowed.has(value)) return value;
  if (allowed.has(fallback)) return fallback;
  // fallback 不在白名单：退回白名单首个允许值（保守，保证产出端永不写出非法枚举）。
  const first = allowed.values().next();
  return first.done ? fallback : first.value;
}

// DRAFT-01 / DRAFT-04 修复：判断 capabilities 源是否「合法非空对象数组」。
// 用于 mergeFollowupDraft / mergeFollowupDraftWithSandbox：仅当 parsed 提供合法 capabilities
// 才覆盖 prev，否则透传 prev（避免追问未重发完整 manifest 时多能力降级为单能力兜底）。
export function hasValidCapabilities(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every(
      (c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && typeof (c as { kind?: unknown }).kind === 'string' && FRONTEND_CAPABILITY_KINDS.has((c as { kind: CapabilityKindType }).kind),
    );
}

// parseStructuredPackage 的返回结构。
function escapeHtml(input: string): string {
  return input.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] || char));
}

export function buildFallbackEntryHtml(input: { notes?: string; manifestName: string; description?: string }): string {
  const name = escapeHtml(input.manifestName || '本地代码助手插件');
  const desc = escapeHtml(input.description || '');
  const notes = escapeHtml(input.notes || '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    main { max-width: 720px; margin: 0 auto; padding: 32px; }
    section { border: 1px solid #e2e8f0; border-radius: 18px; background: white; padding: 24px; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { line-height: 1.7; color: #475569; }
    pre { white-space: pre-wrap; word-break: break-word; border-radius: 14px; background: #0f172a; color: #e2e8f0; padding: 16px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${name}</h1>
      <p>${desc || '本地代码助手未产出入口文件，已生成兜底预览页。'}</p>
      <pre>${notes || '（无说明）'}</pre>
    </section>
  </main>
</body>
</html>`;
}
export function parseManifest(files: DraftFile[]) {
  const manifestFile = files.find((file) => file.path === 'manifest.json');
  try {
    const parsed = JSON.parse(manifestFile?.content || '{}');
    return {
      id: parsed.id || parsed.name || 'generated-plugin',
      name: parsed.name || '未命名插件',
      // 用户命名（PRD 需求 1 / AC1）：title 优先于 name 作为展示名。
      // 上传时 doUpload 把用户填的名写入 title 落盘，scan_one_plugin 同样 title 优先回退。
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '',
      version: parsed.version || '0.1.0',
      description: parsed.description || '',
      runtime_type: parsed.runtime_type || parsed.runtimeType || 'client',
      entry: parsed.entry || 'ui/index.html',
      visibility: parsed.visibility || 'tenant',
      // 契约收敛：localStorage 读取的历史草稿（含旧字符串数组形态）在此统一收敛为合法对象数组。
      capabilities: normalizeCapabilities(parsed.capabilities),
    };
  } catch {
    // 解析失败：无能力声明，空数组合法（后端接受）。
    return { id: 'generated-plugin', name: '未命名插件', title: '', version: '0.1.0', description: '', runtime_type: 'client', entry: 'ui/index.html', visibility: 'tenant', capabilities: [] };
  }
}

export function previewSrcDoc(files: DraftFile[]): string {
  const manifest = parseManifest(files);
  const html = files.find((file) => file.path === manifest.entry)?.content || '<p>无预览入口</p>';
  // SDK-06 修复：预览态同样注入宿主设计令牌，与运行态 tokensStyles() 行为一致，
  // 让创建器预览的 var(--lf-color-*) 正确解析（而非依赖插件自身 fallback）。
  const tokens = `<style data-lf-tokens>:root{--lf-color-primary:#2563eb;--lf-color-bg:#fafafa;--lf-color-text:#1a1a1a;--lf-color-border:#dddddd;--lf-radius-md:10px;--lf-spacing-md:14px;--lf-font-sans:system-ui,sans-serif;}</style>`;
  const shim = `<script>
    window.sdk = {
      invoke: async (cap) => { alert('能力 ' + cap + ' 将由宿主网关提供'); },
      codeAssistant: { run: async () => '（预览态：发布后由本地代码助手执行）' },
      ui: { render: (c) => { document.body.insertAdjacentHTML('beforeend', '<pre>' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '</pre>'); } },
    };
  <\/script>`;
  return tokens + shim + html;
}

export function recentKey(tenantId: string | null) {
  return `lf:recent-plugins:${tenantId || 'none'}`;
}

export function readRecent(tenantId: string | null): LoadedPlugin[] {
  try {
    const raw = localStorage.getItem(recentKey(tenantId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRecent(tenantId: string | null, plugins: LoadedPlugin[]) {
  try {
    localStorage.setItem(recentKey(tenantId), JSON.stringify(plugins.slice(0, 8)));
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

/**
 * 插件结构校验：检测 AI 生成结果是否符合运行要求（manifest 存在 + 入口文件存在 + 入口名规范）。
 *
 * 返回诊断数组（空=结构正常）。供创建器 finalizeSession 后追加进 draft.diagnostics，
 * 让详情面板「检查结果」显式提示结构问题，避免「AI 写了文件但缺 manifest/入口名错」时
 * 用户以为生成成功却无法运行。
 *
 * 检测项：
 * - files 非空但无 manifest.json → fail（无法运行，引导重新生成）。
 * - 有 manifest 但 entry 文件不在 files → warn（scan 判 incomplete，运行会报错）。
 * - Python 入口非 main.py / Node 入口非 index.js → warn（不规范，建议改名）。
 */
export function validatePluginStructure(files: DraftFile[]): DraftDiagnostic[] {
  const diagnostics: DraftDiagnostic[] = [];
  if (files.length === 0) return diagnostics; // 纯对话态不校验。

  const hasManifest = files.some((f) => f.path === 'manifest.json');
  if (!hasManifest) {
    diagnostics.push({
      stage: 'schema',
      status: 'fail',
      message: '缺少 manifest.json，插件无法运行。请让 AI 重新生成并确保产出 manifest.json 清单文件。',
    });
    return diagnostics; // 无 manifest 则后续 entry 校验无意义。
  }

  const manifest = parseManifest(files);
  const entryExists = files.some((f) => f.path === manifest.entry);
  if (!entryExists) {
    diagnostics.push({
      stage: 'schema',
      status: 'warn',
      message: `入口文件 ${manifest.entry} 不存在（manifest.entry 指向的文件未生成）。运行时会报错。`,
    });
  }

  // 入口名规范提示（python 应为 main.py，nodejs 应为 index.js）。
  if (manifest.runtime_type === 'python' && manifest.entry !== 'main.py') {
    diagnostics.push({
      stage: 'schema',
      status: 'warn',
      message: `Python 插件入口建议命名为 main.py（当前为 ${manifest.entry}）。虽然可运行，但不符合规范。`,
    });
  } else if (manifest.runtime_type === 'nodejs' && manifest.entry !== 'index.js') {
    diagnostics.push({
      stage: 'schema',
      status: 'warn',
      message: `Node 插件入口建议命名为 index.js（当前为 ${manifest.entry}）。`,
    });
  }

  return diagnostics;
}
