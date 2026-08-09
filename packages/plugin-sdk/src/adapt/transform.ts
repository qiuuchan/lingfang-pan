// adapt/transform.ts —— 确定性自动改造（codemod 式）。
//
// 每条 transform：读取工作区 → 修复可确定化的问题 → 写回临时工作区 → 返回 FixApplied[]。
// 全部幂等：重复执行结果一致。只改临时 adaptation 工作区，绝不碰用户原始源码
// （拷贝由 index.ts 编排器负责）。A4 等高风险改造保留 diff 供人工复核。

import type { FixApplied } from './report.ts';
import type { AdaptWorkspace } from './workspace.ts';

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9-_.]*$/;
const RUNTIME_ENTRY_DEFAULT: Record<string, string> = {
  client: 'ui/index.html',
  nodejs: 'index.js',
  python: 'main.py',
};
const RUNTIME_ENTRY_EXT: Record<string, string[]> = {
  client: ['.html'],
  nodejs: ['.js', '.mjs', '.cjs'],
  python: ['.py'],
};

function slugFromName(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) s = 'plugin';
  if (!/^[a-z]/.test(s)) s = `plugin.${s}`;
  return s.slice(0, 64);
}

/**
 * 基于源码推导运行时：
 *   package.json 带 scripts.start/main/bin 或依赖 → nodejs；
 *   存在 main.py/app.py/__main__.py → python；
 *   存在 ui/index.html/index.html → client；
 *   否则落默认 client。
 * 用于「覆盖而非沿用」仓库自带 manifest 的运行时字段（方案修正 4）。
 */
function deriveRuntime(ws: AdaptWorkspace): string {
  const pkgRaw = ws.readFile('package.json');
  if (pkgRaw != null) {
    try {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const scripts = (pkg.scripts as Record<string, unknown> | undefined) ?? {};
      const hasNodeScript = ['start', 'dev', 'main', 'serve', 'run'].some((k) => k in scripts);
      const hasMain = typeof pkg.main === 'string';
      const hasBin = typeof pkg.bin === 'string' || (pkg.bin != null && typeof pkg.bin === 'object');
      const deps = pkg.dependencies;
      const hasNodeDeps = deps != null && typeof deps === 'object' && Object.keys(deps as object).length > 0;
      if (hasNodeScript || hasMain || hasBin || hasNodeDeps) return 'nodejs';
    } catch {
      // 损坏的 package.json 不阻塞：继续按入口文件判断。
    }
  }
  const nodeEntries = ['index.js', 'server.js', 'app.js', 'main.js', 'index.mjs', 'index.cjs'];
  if (nodeEntries.some((e) => ws.exists(e))) return 'nodejs';
  if (ws.exists('main.py') || ws.exists('app.py') || ws.exists('__main__.py')) return 'python';
  if (ws.exists('ui/index.html') || ws.exists('index.html')) return 'client';
  return 'client';
}

/** A1 缺字段补齐：name / id / runtime_type / entry / version / visibility。 */
export function transformMissingFields(ws: AdaptWorkspace, manifest: Record<string, unknown>): FixApplied[] {
  const fixes: FixApplied[] = [];

  // name 优先取 package.json.name，否则用目录名（manifest.name 缺省为必填项）。
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    let derivedName = '';
    const pkgRaw = ws.readFile('package.json');
    if (pkgRaw != null) {
      try {
        const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
        if (typeof pkg.name === 'string' && pkg.name.trim() !== '') derivedName = pkg.name.trim();
      } catch {
        // 损坏 package.json 忽略，回退到目录名。
      }
    }
    if (!derivedName) derivedName = ws.dir.split(/[\\/]/).pop() ?? 'plugin';
    const before = String(manifest.name ?? '');
    manifest.name = derivedName;
    fixes.push({ code: 'A1_name', category: 'manifest', message: `补齐 name → ${derivedName}`, path: 'name', diff: { before, after: derivedName } });
  }

  const name = typeof manifest.name === 'string' ? manifest.name : '';

  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    const newId = slugFromName(name || (ws.dir.split(/[\\/]/).pop() ?? 'plugin'));
    const before = String(manifest.id ?? '');
    manifest.id = newId;
    fixes.push({ code: 'A1_id', category: 'manifest', message: `补齐/修正 id → ${newId}`, path: 'id', diff: { before, after: newId } });
  }

  // 运行时：先由 package.json / 入口文件推导，找不到再落默认 client（覆盖而非沿用自带值）。
  if (typeof manifest.runtime_type !== 'string' || !RUNTIME_ENTRY_DEFAULT[manifest.runtime_type]) {
    const derived = deriveRuntime(ws);
    const before = String(manifest.runtime_type ?? '');
    manifest.runtime_type = derived;
    fixes.push({ code: 'A1_runtime', category: 'manifest', message: `运行时推导为 ${derived}`, path: 'runtime_type', diff: { before, after: derived } });
  }

  if (typeof manifest.entry !== 'string' || manifest.entry.trim() === '') {
    const def = RUNTIME_ENTRY_DEFAULT[manifest.runtime_type as string];
    manifest.entry = def;
    fixes.push({ code: 'A1_entry', category: 'manifest', message: `补齐 entry → ${def}`, path: 'entry', diff: { before: String(manifest.entry ?? ''), after: def } });
  }

  if (typeof manifest.version !== 'string' || manifest.version === '0.0.0' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    const before = String(manifest.version ?? '');
    manifest.version = '0.1.0';
    fixes.push({ code: 'A1_version', category: 'manifest', message: 'version 缺省为 0.1.0', path: 'version', diff: { before, after: '0.1.0' } });
  }

  if (typeof manifest.visibility !== 'string') {
    manifest.visibility = 'private';
    fixes.push({ code: 'A1_visibility', category: 'manifest', message: 'visibility 缺省为 private', path: 'visibility' });
  }

  return fixes;
}

/** A2 entry/runtime 不匹配：文件存在但扩展名错 → 改写 entry；缺入口 → 指向/生成默认骨架。 */
export function transformEntry(ws: AdaptWorkspace, manifest: Record<string, unknown>): FixApplied[] {
  const fixes: FixApplied[] = [];
  const rt = manifest.runtime_type as string;
  const exts = RUNTIME_ENTRY_DEFAULT[rt] ? RUNTIME_ENTRY_EXT[rt] : ['.html', '.js', '.mjs', '.cjs', '.py'];
  let entry = (manifest.entry as string) || RUNTIME_ENTRY_DEFAULT[rt] || 'index.html';

  const hasCorrectExt = exts.some((e) => entry.endsWith(e));

  if (ws.exists(entry)) {
    if (!hasCorrectExt) {
      // 扩展名不匹配但文件存在：找同目录下带正确扩展名的同名基名文件
      const base = entry.replace(/\.[^.]+$/, '');
      const candidate = exts.map((e) => `${base}${e}`).find((c) => ws.exists(c));
      if (candidate) {
        const before = entry;
        entry = candidate;
        manifest.entry = entry;
        fixes.push({ code: 'A2_entry_ext', category: 'runtime', message: `entry 扩展名不匹配，改写为 ${candidate}`, path: 'entry', diff: { before, after: candidate } });
      }
    }
  } else {
    // 文件不存在：先尝试工作区内是否存在默认候选
    const def = RUNTIME_ENTRY_DEFAULT[rt];
    if (def && ws.exists(def)) {
      const before = entry;
      entry = def;
      manifest.entry = entry;
      fixes.push({ code: 'A2_entry_default', category: 'runtime', message: `入口缺失，指向默认 ${def}`, path: 'entry', diff: { before, after: def } });
    } else {
      // 生成最小骨架，使 runtime-check 能继续执行
      const skeleton = skeletonFor(rt);
      if (skeleton != null) {
        ws.writeFile(entry, skeleton);
        fixes.push({ code: 'A2_entry_skeleton', category: 'runtime', message: `入口缺失，生成最小骨架 ${entry}`, path: 'entry' });
      }
      // 无法推断骨架：不记录为「已应用改造」——由重新校验时的 entry_not_found 问题如实暴露。
    }
  }

  return fixes;
}

function skeletonFor(rt: string): string | null {
  if (rt === 'client') return '<!doctype html>\n<html><head><meta charset="utf-8"><title>灵坊插件</title></head><body><script>/* TODO: 实现插件 UI，调用 window.__lingfangInvoke */</script></body></html>\n';
  if (rt === 'nodejs') return "// 灵坊插件入口骨架\nconsole.log('plugin started');\n";
  if (rt === 'python') return '# 灵坊插件入口骨架\nimport os\n\nif __name__ == "__main__":\n    print("plugin started")\n';
  return null;
}

const CAP_MAP: Array<{ re: RegExp; kind: string }> = [
  { re: /\b(requests|httpx|urllib|aiohttp|axios|fetch)\b/, kind: 'net.fetch' },
  { re: /\b(open\(|readFile|readFileSync|fs\.(read|readFile)|pathlib|os\.path)\b/, kind: 'fs.read' },
  { re: /\b(writeFile|writeFileSync|open\([^)]*['"](w|a)['"]|shutil)/, kind: 'fs.write' },
  { re: /\b(pyperclip|clipboard)/, kind: 'clipboard' },
  { re: /(sdk\.llm|llm\.chat|LINGFANG_PLUGIN_BRIDGE_URL|\.chat\.completions|images\.generations|sdk\.image)/, kind: 'llm.chat' },
  { re: /(sdk\.image|images\.generations|image\.generate)/, kind: 'image.generate' },
  { re: /(localStorage|sqlite|kv\.|\.setItem|kv\.set)/, kind: 'storage.kv' },
  { re: /(notification|notify|toast)/, kind: 'system.notify' },
  { re: /(<html|<!doctype html|window\.__lingfangInvoke|document\.)/, kind: 'ui.view' },
];

/** A3 能力自动探测：扫描源码 import/API 调用，补缺失 capabilities（低风险）。 */
export function transformCapabilities(ws: AdaptWorkspace, manifest: Record<string, unknown>): FixApplied[] {
  const fixes: FixApplied[] = [];
  const sources = ws.readAllSources();
  if (sources.size === 0) return fixes;

  const found = new Set<string>();
  for (const [rel, content] of sources) {
    // 只扫实际代码文件：README/说明文档里的示例字符串（\bfetch\b、kv\. 等）会被
    // 未锚定的 CAP_MAP 命中，导致 manifest 被过度授权，违反插件隔离的最少权限原则。
    if (/\.(md|txt)$/.test(rel)) continue;
    for (const m of CAP_MAP) {
      if (m.re.test(content)) found.add(m.kind);
    }
  }

  const existing: Array<{ kind: string }> = Array.isArray(manifest.capabilities) ? (manifest.capabilities as Array<{ kind: string }>) : [];
  const seen = new Set(existing.map((c) => c.kind));
  const added: string[] = [];
  for (const kind of found) {
    if (!seen.has(kind)) {
      existing.push({ kind, reason: `自动探测到 ${kind} 相关调用`, risk: 'low', requires_admin: false } as never);
      seen.add(kind);
      added.push(kind);
    }
  }
  if (added.length > 0) {
    manifest.capabilities = existing;
    fixes.push({ code: 'A3_capabilities', category: 'capability', message: `补齐能力：${added.join(', ')}`, path: 'capabilities' });
  }
  return fixes;
}

/** A4 AI 边界归一化：把硬编码 baseUrl/key/provider 改写为桥接模式（仅在临时工作区，保留 diff）。 */
export function transformAiBoundary(ws: AdaptWorkspace, manifest: Record<string, unknown>): FixApplied[] {
  const fixes: FixApplied[] = [];
  const sources = ws.readAllSources();
  if (sources.size === 0) return fixes;
  const runtimeType = String(manifest.runtime_type ?? 'client');

  for (const [rel, content] of sources) {
    // 按**当前文件**的语言选择桥接写法，而不是看工作区里有没有任何 .py 文件：
    // 混语言工作区里 JS 也吃过 `os.environ[...]`，被改成 Python 语法（修复前行为）。
    const isPython = /\.py$/.test(rel);
    const isJs = /\.(js|mjs|cjs|ts|tsx)$/.test(rel);
    if (!isPython && !isJs) continue;
    let next = content;
    let changed = false;

    // 硬编码 base URL → 桥接 base（保留 + '/v1'）
    next = next.replace(/base[_-]?url\s*[:=]\s*['"](https?:\/\/[^'"]+)['"]/i, (m) => {
      changed = true;
      const replacement = isPython
        ? `base_url=os.environ['LINGFANG_PLUGIN_BRIDGE_URL'] + '/v1'`
        : runtimeType === 'client'
          ? // webview 里没有 process：用带 typeof 守卫的写法，避免 ReferenceError 直接崩掉插件。
            `baseURL:(typeof process!=='undefined'?(process.env?.LINGFANG_PLUGIN_BRIDGE_URL??''):'')+'/v1'`
          : `baseURL: process.env.LINGFANG_PLUGIN_BRIDGE_URL + '/v1'`;
      fixes.push({ code: 'A4_base_url', category: 'ai_boundary', message: 'base URL 归一化为桥接模式', path: rel, diff: { before: m, after: replacement } });
      return replacement;
    });

    // 硬编码 provider
    next = next.replace(/provider\s*[:=]\s*['"](openai|anthropic|deepseek|qwen|moonshot|zhipu|glm)['"]/i, () => {
      changed = true;
      fixes.push({ code: 'A4_provider', category: 'ai_boundary', message: '移除硬编码 provider（不应直连第三方）', path: rel });
      return '';
    });

    // 硬编码真实模型名 → 省略（默认 fast）
    next = next.replace(/model\s*[:=]\s*['"](gpt-4|gpt-3\.5|claude-|text-embedding|deepseek-|qwen-|glm-)[\w.-]*['"]/i, () => {
      changed = true;
      fixes.push({ code: 'A4_model', category: 'ai_boundary', message: '移除硬编码真实模型名（省略即默认 fast）', path: rel });
      return '';
    });

    // 硬编码凭据 → 桥 token（A4_key）。覆盖 validate 的 leaked_openai_key / leaked_api_key
    // 所告发的两种形态：`api[key] = 'sk-……'` 以及任意 `apiKey[:=]` 长串字面量。
    next = next.replace(/([A-Za-z_$][\w$]*\s*[:=]\s*)['"](sk-[a-zA-Z0-9_-]{8,}|[a-zA-Z0-9_-]{25,})['"]/g, (m, left, _secret) => {
      const leftText = String(left);
      if (!/api[_-]?key|token/i.test(leftText)) return m;
      const tokenExpr = isPython
        ? `os.environ['LINGFANG_PLUGIN_BRIDGE_TOKEN']`
        : runtimeType === 'client'
          ? `(typeof process !== 'undefined' ? (process.env?.LINGFANG_PLUGIN_BRIDGE_TOKEN ?? '') : '')`
          : `process.env.LINGFANG_PLUGIN_BRIDGE_TOKEN`;
      changed = true;
      fixes.push({ code: 'A4_key', category: 'ai_boundary', message: '硬编码凭据改写为桥接 token', path: rel });
      return `${String(left)}${tokenExpr}`;
    });

    if (changed) ws.writeFile(rel, next);
  }
  return fixes;
}

/** A5 依赖归一化：python 缺 requirements.txt 但检测到第三方 import → 生成最佳猜测清单。 */
export function transformDependencies(ws: AdaptWorkspace, manifest: Record<string, unknown>): FixApplied[] {
  const fixes: FixApplied[] = [];
  if (manifest.runtime_type !== 'python') return fixes;
  if (ws.exists('requirements.txt')) return fixes;

  const sources = ws.readAllSources();
  // 必须带 g 标记：matchAll 遇到非全局 RegExp 会直接抛 TypeError（ES 规范），
  // 否则任何有 .py 源文件且无 requirements.txt 的插件都会让整个适配流水线崩掉。
  const IMPORT_RE = /^import\s+([a-zA-Z_][\w.]*)|^from\s+([a-zA-Z_][\w.]*)\s+import/gm;
  const stdlib = new Set([
    'os','sys','re','json','math','time','datetime','pathlib','argparse','collections','typing',
    'functools','itertools','random','string','hashlib','base64','io','subprocess','shutil','glob',
    'tempfile','logging','traceback','textwrap','dataclasses','enum','abc','asyncio','threading',
  ]);
  const dist: Record<string, string> = { PIL: 'pillow', bs4: 'beautifulsoup4', yaml: 'pyyaml', openpyxl: 'openpyxl' };
  const deps = new Set<string>();
  for (const content of sources.values()) {
    const matches = content.matchAll(IMPORT_RE);
    for (const m of matches) {
      const top = (m[1] ?? m[2] ?? '').split('.')[0];
      if (!top || stdlib.has(top)) continue;
      deps.add(dist[top] ?? top);
    }
  }
  if (deps.size > 0) {
    ws.writeFile('requirements.txt', [...deps].sort().join('\n') + '\n');
    fixes.push({ code: 'A5_requirements', category: 'dependency', message: `生成 requirements.txt：${[...deps].join(', ')}`, path: 'requirements.txt' });
  }
  return fixes;
}

/**
 * 运行全部确定性 transform（A1-A5）。返回所有已应用改造的合并列表。
 * 调用方负责先把源码拷贝到临时工作区，并传入可变 manifest 对象。
 */
export function applyTransforms(ws: AdaptWorkspace, manifest: Record<string, unknown>): FixApplied[] {
  const all: FixApplied[] = [];
  all.push(...transformMissingFields(ws, manifest));
  all.push(...transformEntry(ws, manifest));
  all.push(...transformCapabilities(ws, manifest));
  all.push(...transformAiBoundary(ws, manifest));
  all.push(...transformDependencies(ws, manifest));
  return all;
}
