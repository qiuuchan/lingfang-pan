export const PLUGIN_AI_POLICY_VERSION = 1 as const;
export const PLUGIN_AI_POLICY_MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
export const PLUGIN_AI_POLICY_MAX_DEPENDENCY_BYTES = 256 * 1024;
export const PLUGIN_AI_POLICY_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export type PluginAiCapability = 'llm.chat' | 'image.generate';

export type PluginAiPolicyDiagnostic = {
  code:
    | 'ai.config.forbidden'
    | 'ai.endpoint.third_party'
    | 'ai.sdk.third_party'
    | 'ai.bridge.custom'
    | 'ai.bridge.secret_sink'
    | 'ai.model.invalid'
    | 'ai.capability.missing'
    | 'ai.policy.unscannable';
  path: string;
  line?: number;
  message: string;
  capability?: PluginAiCapability;
};

export type PluginAiPolicyFile = {
  path: string;
  content?: string;
  binary?: boolean;
  scanError?: 'too_large' | 'dependency_too_large' | 'invalid_utf8' | 'total_too_large';
};

export type PluginAiPolicyInput = {
  manifest: unknown;
  files: PluginAiPolicyFile[];
};

export type PluginAiPolicyResult = {
  policyVersion: typeof PLUGIN_AI_POLICY_VERSION;
  ok: boolean;
  diagnostics: PluginAiPolicyDiagnostic[];
  requiredCapabilities: PluginAiCapability[];
  truncated: boolean;
};

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.cts', '.env', '.htm', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.mts',
  '.py', '.svelte', '.toml', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml',
]);
const DEPENDENCY_FILES = new Set(['package.json', 'requirements.txt', 'pyproject.toml']);
const AI_CAPABILITIES = new Set<PluginAiCapability>(['llm.chat', 'image.generate']);
const ALLOWED_OPENAI_PACKAGES = new Set(['openai', '@ai-sdk/openai']);
const FORBIDDEN_NODE_PACKAGES = new Set([
  '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', 'cohere-ai', 'groq-sdk',
  'mistralai', 'replicate', 'stability-ai', 'together-ai', 'ollama',
]);
const FORBIDDEN_PYTHON_PACKAGES = new Set([
  'anthropic', 'cohere', 'google-generativeai', 'google-genai', 'groq', 'mistralai',
  'replicate', 'stability-sdk', 'together', 'dashscope', 'ollama',
]);

const THIRD_PARTY_ENDPOINTS: Array<[RegExp, string]> = [
  [/api\.openai\.com/i, 'OpenAI'],
  [/api\.anthropic\.com/i, 'Anthropic'],
  [/generativelanguage\.googleapis\.com/i, 'Google AI'],
  [/api\.groq\.com/i, 'Groq'],
  [/api\.replicate\.com/i, 'Replicate'],
  [/api\.stability\.ai/i, 'Stability AI'],
  [/api\.together\.xyz/i, 'Together AI'],
  [/api\.mistral\.ai/i, 'Mistral'],
  [/dashscope\.aliyuncs\.com/i, 'DashScope'],
  [/open\.bigmodel\.cn/i, '智谱 AI'],
  [/api\.moonshot\.cn/i, 'Moonshot'],
  [/api\.deepseek\.com/i, 'DeepSeek'],
];

function extension(path: string): string {
  const filename = path.toLowerCase().split('/').pop() || '';
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.slice(index);
}

export function isPluginAiPolicyTextPath(path: string): boolean {
  const filename = path.toLowerCase().split('/').pop() || '';
  return DEPENDENCY_FILES.has(filename) || TEXT_EXTENSIONS.has(extension(filename));
}

export function pluginAiPolicyTextLimit(path: string): number {
  const filename = path.toLowerCase().split('/').pop() || '';
  return DEPENDENCY_FILES.has(filename)
    ? PLUGIN_AI_POLICY_MAX_DEPENDENCY_BYTES
    : PLUGIN_AI_POLICY_MAX_TEXT_FILE_BYTES;
}

export function decodePluginAiPolicyText(path: string, bytes: Buffer): PluginAiPolicyFile {
  const dependency = DEPENDENCY_FILES.has(path.toLowerCase().split('/').pop() || '');
  if (bytes.length > pluginAiPolicyTextLimit(path)) {
    return { path, scanError: dependency ? 'dependency_too_large' : 'too_large' };
  }
  if (bytes.includes(0)) return { path, scanError: 'invalid_utf8' };
  try {
    return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { path, scanError: 'invalid_utf8' };
  }
}

function sourceWithoutComments(content: string, path: string): string[] {
  const ext = extension(path);
  const slashComments = ['.cjs', '.css', '.htm', '.html', '.js', '.jsx', '.mjs', '.mts', '.cts', '.ts', '.tsx', '.vue', '.svelte'].includes(ext);
  const hashComments = ['.env', '.py', '.toml', '.yaml', '.yml'].includes(ext)
    || ['requirements.txt', 'dockerfile'].includes(path.toLowerCase().split('/').pop() || '');
  type Mode = 'normal' | 'single' | 'double' | 'template' | 'triple_single' | 'triple_double' | 'line' | 'block' | 'html';
  let mode: Mode = 'normal';
  let output = '';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const next = content[index + 1] || '';
    const nextTwo = content.slice(index, index + 3);
    if (mode === 'line') {
      if (char === '\n') {
        output += '\n';
        mode = 'normal';
      }
      continue;
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') {
        mode = 'normal';
        index += 1;
      } else if (char === '\n') output += '\n';
      continue;
    }
    if (mode === 'html') {
      if (content.slice(index, index + 3) === '-->') {
        mode = 'normal';
        index += 2;
      } else if (char === '\n') output += '\n';
      continue;
    }
    if (mode === 'triple_single' || mode === 'triple_double') {
      const delimiter = mode === 'triple_single' ? "'''" : '\"\"\"';
      output += char;
      if (nextTwo === delimiter) {
        output += content.slice(index + 1, index + 3);
        index += 2;
        mode = 'normal';
      }
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      output += char;
      if (char === '\\' && next) {
        output += next;
        index += 1;
        continue;
      }
      const delimiter = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (char === delimiter) mode = 'normal';
      continue;
    }
    if (content.slice(index, index + 4) === '<!--') {
      mode = 'html';
      index += 3;
      continue;
    }
    if (slashComments && char === '/' && next === '*') {
      mode = 'block';
      index += 1;
      continue;
    }
    if (slashComments && char === '/' && next === '/') {
      mode = 'line';
      index += 1;
      continue;
    }
    if (hashComments && char === '#') {
      mode = 'line';
      continue;
    }
    if (nextTwo === "'''" || nextTwo === '\"\"\"') {
      output += nextTwo;
      mode = nextTwo === "'''" ? 'triple_single' : 'triple_double';
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      output += char;
      mode = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
      continue;
    }
    output += char;
  }
  return output.split(/\r?\n/);
}

function manifestCapabilities(manifest: unknown): Set<PluginAiCapability> {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return new Set();
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capabilities)) return new Set();
  const result = new Set<PluginAiCapability>();
  for (const item of capabilities) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const kind = (item as { kind?: unknown }).kind;
    if (typeof kind === 'string' && AI_CAPABILITIES.has(kind as PluginAiCapability)) {
      result.add(kind as PluginAiCapability);
    }
  }
  return result;
}

function scanManifest(manifest: unknown, add: (diagnostic: PluginAiPolicyDiagnostic) => void): void {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    add({ code: 'ai.policy.unscannable', path: 'manifest.json', message: 'manifest 必须是可扫描的对象' });
    return;
  }
  const scanString = (value: string, path: string): void => {
    for (const [pattern, provider] of THIRD_PARTY_ENDPOINTS) {
      if (pattern.test(value)) {
        add({ code: 'ai.endpoint.third_party', path: 'manifest.json', message: `manifest 不得配置 ${provider} 模型端点：${path}` });
      }
    }
    if (/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/.test(value)) {
      add({ code: 'ai.config.forbidden', path: 'manifest.json', message: `manifest 不得包含硬编码模型密钥：${path}` });
    }
  };
  const visit = (value: unknown, path: string, aiContext: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, aiContext));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const capabilityKind = typeof object.kind === 'string' && AI_CAPABILITIES.has(object.kind as PluginAiCapability);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase().replace(/[-_]/g, '');
      const nextPath = path ? `${path}.${key}` : key;
      const nextAiContext = aiContext || capabilityKind || /(ai|llm|chat|image|model|openai|anthropic)/i.test(key);
      if (['apikey', 'apiurl', 'baseurl', 'authorization'].includes(lower)
        || (['provider', 'endpoint'].includes(lower) && nextAiContext)) {
        add({
          code: 'ai.config.forbidden',
          path: 'manifest.json',
          message: `manifest 不得配置模型密钥或地址字段：${nextPath}`,
        });
      }
      if (lower === 'model' && nextAiContext && typeof child === 'string' && child !== 'fast' && child !== 'premium') {
        add({ code: 'ai.model.invalid', path: 'manifest.json', message: '插件模型档位只允许 fast 或 premium' });
      }
      if (typeof child === 'string') scanString(child, nextPath);
      visit(child, nextPath, nextAiContext);
    }
  };
  visit(manifest, '', false);
}

function parseNodeDependencies(content: string): { names: string[]; invalid: boolean } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = parsed[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
      Object.keys(dependencies as Record<string, unknown>).forEach((name) => names.add(name.toLowerCase()));
    }
    return { names: [...names], invalid: false };
  } catch {
    return { names: [], invalid: true };
  }
}

function pythonDependencyName(line: string): string | null {
  const value = line.trim();
  if (!value || value.startsWith('#') || value.startsWith('-') || value.includes('://')) return null;
  return value.split(';', 1)[0]!.split('[', 1)[0]!.match(/^[A-Za-z0-9_.-]+/)?.[0]?.toLowerCase() || null;
}

function bridgeEnvHasFallback(line: string): boolean {
  if (!/LINGFANG_PLUGIN_BRIDGE_(?:URL|TOKEN)/.test(line)) return false;
  const operatorFallback = line.match(/(?:\|\||\?\?)\s*(['"])(.*?)\1/);
  if (operatorFallback) return operatorFallback[2]!.length > 0;
  if (/(?:\|\||\?\?)/.test(line)) return true;
  const functionFallback = line.match(/(?:getenv|environ\.get|get)\s*\([^,]+,\s*(['"])(.*?)\1\s*\)/);
  if (functionFallback) return functionFallback[2]!.length > 0;
  return /(?:getenv|environ\.get|get)\s*\([^,]+,/.test(line);
}

function lineUsesAllowedBridgeValue(line: string): boolean {
  return /LINGFANG_PLUGIN_BRIDGE_(?:URL|TOKEN)/.test(line) && !bridgeEnvHasFallback(line);
}

function detectCapabilities(text: string, required: Set<PluginAiCapability>): void {
  if (/sdk\.llm\.chat\s*\(|__lingfangInvoke\s*\(\s*['"]llm\.chat['"]|\.chat\.completions\.create\s*\(|\/v1\/chat\/completions/i.test(text)) {
    required.add('llm.chat');
  }
  if (/sdk\.image\.generate\s*\(|__lingfangInvoke\s*\(\s*['"]image\.generate['"]|\.images\.(?:generate|generations)\s*\(|\/v1\/images\/generations/i.test(text)) {
    required.add('image.generate');
  }
}

function looksLikeAiDependency(name: string): boolean {
  return /(?:^|[-/@])(openai|anthropic|groq|mistral|replicate|cohere|ollama|langchain|llama|gemini|generative-ai|ai-sdk)(?:$|[-/])/.test(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasOpenAiBridgeBinding(text: string): boolean {
  if (!/(?:new\s+OpenAI|\bOpenAI|createOpenAI)\s*\(/.test(text)) return false;
  const directUrl = /(?:base_url|baseURL)\s*[:=][^\n,}]*LINGFANG_PLUGIN_BRIDGE_URL[^\n,}]*/.exec(text)?.[0] || '';
  const directToken = /(?:api_key|apiKey)\s*[:=][^\n,}]*LINGFANG_PLUGIN_BRIDGE_TOKEN/.test(text);
  let urlBound = Boolean(directUrl);
  let tokenBound = directToken;
  let v1Bound = /\/v1/.test(directUrl);
  const identifiers = (name: 'URL' | 'TOKEN') => [...text.matchAll(new RegExp(
    `(?:const|let|var)?\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*[^\\n;]*LINGFANG_PLUGIN_BRIDGE_${name}[^\\n;]*`,
    'g',
  ))].map((match) => ({ name: match[1]!, assignment: match[0] }));
  for (const variable of identifiers('URL')) {
    const option = new RegExp(`(?:base_url|baseURL)\\s*[:=][^\\n,}]*\\b${escapeRegExp(variable.name)}\\b[^\\n,}]*`).exec(text)?.[0] || '';
    if (option) {
      urlBound = true;
      v1Bound ||= /\/v1/.test(variable.assignment) || /\/v1/.test(option);
    }
  }
  for (const variable of identifiers('TOKEN')) {
    if (new RegExp(`(?:api_key|apiKey)\\s*[:=][^\\n,}]*\\b${escapeRegExp(variable.name)}\\b`).test(text)) {
      tokenBound = true;
    }
  }
  return urlBound && tokenBound && v1Bound;
}

function scanSourceFile(
  file: PluginAiPolicyFile,
  required: Set<PluginAiCapability>,
  standardOpenAiUsage: { value: boolean; bound: boolean },
  bridgeEnv: { url: boolean; token: boolean },
  add: (diagnostic: PluginAiPolicyDiagnostic) => void,
): void {
  const path = file.path;
  if (file.scanError) {
    const reason = file.scanError === 'dependency_too_large'
      ? '依赖声明超过 256 KiB'
      : file.scanError === 'too_large'
        ? '可执行文本超过 4 MiB'
        : file.scanError === 'total_too_large'
          ? '可扫描文本总量超过 32 MiB'
          : '文本不是有效 UTF-8 或包含 NUL';
    add({ code: 'ai.policy.unscannable', path, message: reason });
    return;
  }
  if (file.binary || typeof file.content !== 'string') return;
  const lines = sourceWithoutComments(file.content, path);
  const text = lines.join('\n');
  const aiTextContext = /(?:sdk\.(?:llm|image)|llm\.chat|image\.generate|openai|anthropic|chat\.completions|images\.generat|LINGFANG_PLUGIN_BRIDGE_)/i.test(text);
  detectCapabilities(text, required);
  bridgeEnv.url ||= /LINGFANG_PLUGIN_BRIDGE_URL/.test(text);
  bridgeEnv.token ||= /LINGFANG_PLUGIN_BRIDGE_TOKEN/.test(text);
  standardOpenAiUsage.value ||= /(?:from\s+openai\s+import|import\s+OpenAI\s+from\s+['"]openai['"]|require\s*\(\s*['"]openai['"]|@ai-sdk\/openai)/i.test(text);
  standardOpenAiUsage.bound ||= hasOpenAiBridgeBinding(text);

  const filename = path.toLowerCase().split('/').pop() || '';
  if (filename === 'package.json') {
    const dependencies = parseNodeDependencies(file.content);
    if (dependencies.invalid) {
      add({ code: 'ai.policy.unscannable', path, message: 'package.json 不是有效 JSON' });
    }
    for (const name of dependencies.names) {
      if (ALLOWED_OPENAI_PACKAGES.has(name)) standardOpenAiUsage.value = true;
      if (FORBIDDEN_NODE_PACKAGES.has(name) || (looksLikeAiDependency(name) && !ALLOWED_OPENAI_PACKAGES.has(name))) {
        add({ code: 'ai.sdk.third_party', path, message: `不得依赖第三方模型 SDK：${name}` });
      }
    }
  }
  if (filename === 'requirements.txt') {
    lines.forEach((line, index) => {
      const name = pythonDependencyName(line);
      if (name === 'openai') standardOpenAiUsage.value = true;
      if (name && (FORBIDDEN_PYTHON_PACKAGES.has(name) || (looksLikeAiDependency(name) && name !== 'openai'))) {
        add({ code: 'ai.sdk.third_party', path, line: index + 1, message: `不得依赖第三方模型 SDK：${name}` });
      }
    });
  }
  if (filename === 'pyproject.toml') {
    lines.forEach((line, index) => {
      for (const name of FORBIDDEN_PYTHON_PACKAGES) {
        if (new RegExp(`['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[<>=~!;\\s'\"]|$)`, 'i').test(line)) {
          add({ code: 'ai.sdk.third_party', path, line: index + 1, message: `不得依赖第三方模型 SDK：${name}` });
        }
      }
      if (/['"]openai(?:[<>=~!;\s'"]|$)/i.test(line)) standardOpenAiUsage.value = true;
    });
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) return;
    for (const [pattern, provider] of THIRD_PARTY_ENDPOINTS) {
      if (pattern.test(line)) {
        add({ code: 'ai.endpoint.third_party', path, line: lineNumber, message: `不得直连 ${provider} 模型端点` });
      }
    }
    if (/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/.test(line)) {
      add({ code: 'ai.config.forbidden', path, line: lineNumber, message: '源码不得包含硬编码模型密钥' });
    }
    if (/(?:from\s+(?:anthropic|groq|mistralai|replicate|dashscope|google\.generativeai)\s+import|require\s*\(\s*['"](?:@anthropic-ai\/sdk|groq-sdk|replicate|mistralai)['"]|from\s+['"](?:@anthropic-ai\/sdk|groq-sdk|replicate|mistralai)['"])/i.test(line)) {
      add({ code: 'ai.sdk.third_party', path, line: lineNumber, message: '不得直接使用第三方模型 SDK' });
    }
    if (bridgeEnvHasFallback(line)) {
      add({ code: 'ai.bridge.custom', path, line: lineNumber, message: '宿主 bridge 环境变量不得配置自定义 fallback' });
    }
    if (/(?:console\.(?:log|debug|info)|\bprint\s*\(|writeFile|appendFile|localStorage|sessionStorage)/.test(line)
      && /LINGFANG_PLUGIN_BRIDGE_(?:URL|TOKEN)/.test(line)) {
      add({ code: 'ai.bridge.secret_sink', path, line: lineNumber, message: '不得打印或持久化宿主 bridge 连接信息' });
    }
    if (aiTextContext
      && /(?:api[_-]?key|api[_-]?url|base[_-]?url|baseURL|authorization|model[_-]?provider)\s*[:=]/i.test(line)
      && !lineUsesAllowedBridgeValue(line)) {
      add({ code: 'ai.config.forbidden', path, line: lineNumber, message: '插件不得配置模型 Key、URL、provider 或 Authorization' });
    }
    const model = line.match(/\bmodel\s*[:=]\s*['"]([A-Za-z0-9][A-Za-z0-9._:-]*)['"]/i)?.[1];
    if (model && model !== 'fast' && model !== 'premium') {
      add({ code: 'ai.model.invalid', path, line: lineNumber, message: '插件模型档位只允许 fast 或 premium' });
    }
  });
}

export function checkPluginAiPolicy(input: PluginAiPolicyInput): PluginAiPolicyResult {
  const diagnostics: PluginAiPolicyDiagnostic[] = [];
  const dedupe = new Set<string>();
  let truncated = false;
  const add = (diagnostic: PluginAiPolicyDiagnostic) => {
    const key = `${diagnostic.code}\0${diagnostic.path}\0${diagnostic.line || 0}\0${diagnostic.capability || ''}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    diagnostics.push(diagnostic);
  };
  scanManifest(input.manifest, add);
  const declared = manifestCapabilities(input.manifest);
  const required = new Set<PluginAiCapability>();
  const standardOpenAiUsage = { value: false, bound: false };
  const bridgeEnv = { url: false, token: false };
  const manifestEntry = input.manifest && typeof input.manifest === 'object' && !Array.isArray(input.manifest)
    && typeof (input.manifest as { entry?: unknown }).entry === 'string'
    ? (input.manifest as { entry: string }).entry
    : null;
  let totalBytes = 0;
  for (const file of Array.isArray(input.files) ? input.files : []) {
    if (!file || typeof file.path !== 'string') continue;
    const isEntry = manifestEntry === file.path;
    if (isEntry && file.binary) {
      scanSourceFile({ path: file.path, scanError: 'invalid_utf8' }, required, standardOpenAiUsage, bridgeEnv, add);
      continue;
    }
    if (file.binary) continue;
    if (typeof file.content === 'string') {
      const bytes = Buffer.byteLength(file.content, 'utf8');
      const limit = pluginAiPolicyTextLimit(file.path);
      if (bytes > limit) {
        scanSourceFile({
          path: file.path,
          scanError: DEPENDENCY_FILES.has(file.path.toLowerCase().split('/').pop() || '')
            ? 'dependency_too_large'
            : 'too_large',
        }, required, standardOpenAiUsage, bridgeEnv, add);
        continue;
      }
      if (file.content.includes('\0')) {
        scanSourceFile({ path: file.path, scanError: 'invalid_utf8' }, required, standardOpenAiUsage, bridgeEnv, add);
        continue;
      }
      totalBytes += bytes;
      if (totalBytes > PLUGIN_AI_POLICY_MAX_TOTAL_BYTES) {
        scanSourceFile({ path: file.path, scanError: 'total_too_large' }, required, standardOpenAiUsage, bridgeEnv, add);
        break;
      }
    }
    if (isEntry && typeof file.content !== 'string' && !file.scanError) {
      scanSourceFile({ path: file.path, scanError: 'invalid_utf8' }, required, standardOpenAiUsage, bridgeEnv, add);
      continue;
    }
    scanSourceFile(file, required, standardOpenAiUsage, bridgeEnv, add);
  }
  if (manifestEntry && !(Array.isArray(input.files) && input.files.some((file) => file?.path === manifestEntry))) {
    add({ code: 'ai.policy.unscannable', path: manifestEntry, message: 'manifest.entry 缺少可扫描的可执行文本' });
  }
  if (standardOpenAiUsage.value) required.add('llm.chat');
  if (standardOpenAiUsage.value && (!bridgeEnv.url || !bridgeEnv.token || !standardOpenAiUsage.bound)) {
    add({
      code: 'ai.bridge.custom',
      path: 'manifest.json',
      message: '标准 OpenAI 客户端必须同时使用宿主注入的 bridge URL 与 token',
    });
  }
  for (const capability of required) {
    if (!declared.has(capability)) {
      add({
        code: 'ai.capability.missing',
        path: 'manifest.json',
        message: `manifest 必须声明 ${capability}`,
        capability,
      });
    }
  }
  diagnostics.sort((left, right) => left.path.localeCompare(right.path)
    || (left.line || 0) - (right.line || 0)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message));
  if (diagnostics.length > 50) {
    diagnostics.length = 50;
    truncated = true;
  }
  return {
    policyVersion: PLUGIN_AI_POLICY_VERSION,
    ok: diagnostics.length === 0,
    diagnostics,
    requiredCapabilities: [...required].sort(),
    truncated,
  };
}

export function pluginAiPolicyReason(result: PluginAiPolicyResult): string {
  return result.diagnostics
    .slice(0, 5)
    .map((diagnostic) => `${diagnostic.code}:${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ''}`)
    .join('; ')
    .slice(0, 1000);
}
