// adapt/validate.ts —— 静态校验：包装 validateManifest + 目录结构 + AI 边界启发式预检。
//
// 产物是 AdaptationIssue[]（带 fixable 标记）。确定性 transform 只修复 fixable 的问题；
// 其余（needs_human）交人工或 agent。本模块不执行插件，也不修改文件。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest, type ManifestError } from '../manifest/index.ts';
import type { PluginManifest } from '@lingfang/contract';
import type { AdaptationIssue } from './report.ts';
import type { AdaptWorkspace } from './workspace.ts';

/** 复用 validate.ts 的 requirements.txt / package.json 格式检查思路。 */
function structureIssues(ws: AdaptWorkspace, manifest: PluginManifest): AdaptationIssue[] {
  const issues: AdaptationIssue[] = [];

  const entryPath = join(ws.dir, manifest.entry);
  if (!existsSync(entryPath)) {
    issues.push({
      code: 'entry_not_found',
      category: 'structure',
      severity: 'auto_fixable',
      path: manifest.entry,
      message: `入口文件不存在: ${manifest.entry}`,
      fixable: true,
    });
  }
  // 存在即视为通过（内容检查交给 runtime-check）；不要在这里无条件 readFileSync——
  // entry 指向目录/无读权限时会让 validateWorkspace 抛异常，违反「返回问题而非抛错」的契约。

  if (manifest.runtime_type === 'nodejs') {
    const pkgPath = join(ws.dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        JSON.parse(readFileSync(pkgPath, 'utf-8'));
      } catch {
        issues.push({
          code: 'package_json_invalid',
          category: 'structure',
          severity: 'auto_fixable',
          path: 'package.json',
          message: 'package.json 不是合法的 JSON',
          fixable: true,
        });
      }
    }
  }

  if (manifest.runtime_type === 'python') {
    const reqPath = join(ws.dir, 'requirements.txt');
    if (existsSync(reqPath)) {
      const content = readFileSync(reqPath, 'utf-8');
      // 名字部分已在前一步 split 掉版本操作符，这里的版本后缀组永远匹配不到，纯属死逻辑。
      const PIP_PATTERN = /^[a-zA-Z0-9_.-]+$/;
      content.split('\n').forEach((rawLine, i) => {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#') || line.startsWith('-')) return;
        if (line.includes('://') || line.startsWith('.') || line.includes('@ ')) return;
        if (!PIP_PATTERN.test(line.split(/[;<\[]/)[0].split(/[><=!~]/)[0].trim())) {
          issues.push({
            code: 'requirements_invalid_format',
            category: 'dependency',
            severity: 'needs_human',
            path: `requirements.txt:${i + 1}`,
            message: `requirements.txt 第 ${i + 1} 行格式不合法: "${line}"`,
            fixable: false,
          });
        }
      });
    }
  }

  return issues;
}

/** AI 边界启发式预检：扫描源码是否泄露 key / 硬编码 baseUrl / provider / 真实模型名。 */
function aiBoundaryIssues(ws: AdaptWorkspace): AdaptationIssue[] {
  const issues: AdaptationIssue[] = [];
  const sources = ws.readAllSources();
  const LEAK_PATTERNS: Array<{ re: RegExp; code: string; message: string }> = [
    {
      re: /sk-[a-zA-Z0-9]{20,}/,
      code: 'leaked_openai_key',
      message: '检测到硬编码 OpenAI 风格 API Key，应改用平台桥接 token',
    },
    {
      re: /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
      code: 'leaked_api_key',
      message: '检测到硬编码 API Key 字面量，应改用平台桥接 token',
    },
    {
      re: /base[_-]?url\s*[:=]\s*['"](https?:\/\/[^'"]+)['"]/i,
      code: 'hardcoded_base_url',
      message: '检测到硬编码 base URL，脚本应使用 LINGFANG_PLUGIN_BRIDGE_URL 拼接 /v1',
    },
    {
      re: /provider\s*[:=]\s*['"](openai|anthropic|deepseek|qwen|moonshot|zhipu|glm)['"]/i,
      code: 'hardcoded_provider',
      message: '检测到硬编码 provider，灵坊插件不应直连第三方 provider',
    },
    {
      re: /model\s*[:=]\s*['"](gpt-4|gpt-3\.5|claude-|text-embedding|deepseek-|qwen-|glm-)[\w.-]*['"]/i,
      code: 'hardcoded_model_name',
      message: '检测到硬编码真实模型名，应省略 model（默认 fast）或仅用 fast/premium',
    },
  ];

  for (const [rel, content] of sources) {
    // 只扫实际代码文件（与 transform A3 对齐）：文档里的示例 key 不应既告警又进适配报告。
    if (/\.(md|txt)$/.test(rel)) continue;
    for (const p of LEAK_PATTERNS) {
      const m = p.re.exec(content);
      if (m) {
        const lineNo = content.slice(0, m.index).split('\n').length;
        issues.push({
          code: p.code,
          category: 'ai_boundary',
          severity: 'auto_fixable',
          path: `${rel}:${lineNo}`,
          message: p.message,
          // 绝不在 detail 里回显整段命中内容：报告会上送服务端并落库（P2 摄入闸），
          // 明文 key 一旦落库就是持久化泄漏，只留首尾各 4 个字符用于人工定位。
          detail: `命中: ${m[0].slice(0, 4)}…${m[0].slice(-4)}（已打码）`,
          fixable: true,
        });
      }
    }
  }
  return issues;
}

/**
 * 静态校验插件工作区，返回问题列表。
 * 仅读不写。manifest 缺失/非法时返回对应问题而不抛错。
 */
export function validateWorkspace(ws: AdaptWorkspace): AdaptationIssue[] {
  const issues: AdaptationIssue[] = [];

  if (!ws.hasManifest()) {
    issues.push({
      code: 'manifest_not_found',
      category: 'manifest',
      severity: 'auto_fixable',
      path: 'manifest.json',
      message: '缺少 manifest.json，将基于源码（package.json / 入口文件）自动合成',
      fixable: true,
    });
    // 即便缺 manifest，AI 边界扫描（硬编码 key/baseUrl/provider）与源码无关，
    // 仍应运行以免漏报凭据泄漏；结构检查需 manifest，此处跳过。
    issues.push(...aiBoundaryIssues(ws));
    return issues;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ws.manifestPath(), 'utf-8'));
  } catch {
    issues.push({
      code: 'manifest_invalid_json',
      category: 'manifest',
      severity: 'needs_human',
      path: 'manifest.json',
      message: 'manifest.json 不是合法 JSON',
      fixable: false,
    });
    return issues;
  }

  const result = validateManifest(raw);
  if (!result.success) {
    for (const e of result.errors) {
      issues.push(manifestErrorToIssue(e));
    }
    // manifest 不合法时，目录/AI 检查无意义，直接返回
    return issues;
  }

  const manifest = result.manifest;
  issues.push(...structureIssues(ws, manifest));
  issues.push(...aiBoundaryIssues(ws));
  return issues;
}

function manifestErrorToIssue(e: ManifestError): AdaptationIssue {
  const autoFixableCodes = new Set([
    'invalid_id',
    'invalid_version',
    'entry_runtime_mismatch',
    'unsafe_entry_path',
    'unknown_capability',
    'duplicate_capability',
  ]);
  return {
    code: e.code,
    category: 'manifest',
    severity: autoFixableCodes.has(e.code) ? 'auto_fixable' : 'needs_human',
    path: e.path,
    message: e.message,
    fixable: autoFixableCodes.has(e.code),
  };
}
