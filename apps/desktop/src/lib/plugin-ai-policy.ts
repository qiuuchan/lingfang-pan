import { api, tauriInvoke } from '@/lib/api';
import { isBinaryPlaceholder } from '@/lib/draft-plugin';
import type { DraftFile } from '@/lib/types';

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
  capability?: 'llm.chat' | 'image.generate';
};

export type PluginAiPolicyResult = {
  policyVersion: number;
  ok: boolean;
  diagnostics: PluginAiPolicyDiagnostic[];
  requiredCapabilities: Array<'llm.chat' | 'image.generate'>;
  truncated: boolean;
};

type PolicyFile = { path: string; content: string; binary?: boolean };

const passedChecks = new Map<string, PluginAiPolicyResult>();

function normalizedFiles(files: DraftFile[]): PolicyFile[] {
  return files
    .map((file) => {
      const binary = Boolean(file.binary) || isBinaryPlaceholder(file.content);
      return {
        path: file.path,
        content: binary ? '' : file.content,
        binary,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function contentHash(manifest: Record<string, unknown>, files: PolicyFile[]): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest, files }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function policyManifest(files: DraftFile[]): Record<string, unknown> {
  const source = files.find((file) => file.path === 'manifest.json' && !file.binary)?.content;
  if (!source) throw new Error('缺少 manifest.json，无法执行插件 AI 政策检查');
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest.json 必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export async function checkPluginAiPolicy(
  manifest: Record<string, unknown>,
  files: DraftFile[],
): Promise<PluginAiPolicyResult> {
  const payloadFiles = normalizedFiles(files);
  const hash = await contentHash(manifest, payloadFiles);
  if (hash) {
    const cached = Array.from(passedChecks.entries()).find(([key]) => key.endsWith(`:${hash}`))?.[1];
    if (cached) return cached;
  }
  const result = await api<PluginAiPolicyResult>('/api/plugins/policy/check', {
    method: 'POST',
    body: { manifest, files: payloadFiles },
  });
  if (result.ok && hash) passedChecks.set(`${result.policyVersion}:${hash}`, result);
  return result;
}

export function policyDiagnosticMessage(result: PluginAiPolicyResult): string {
  const lines = result.diagnostics.map((diagnostic) => {
    const location = diagnostic.line ? `${diagnostic.path}:${diagnostic.line}` : diagnostic.path;
    return `- ${location} [${diagnostic.code}] ${diagnostic.message}`;
  });
  const suffix = result.truncated ? '\n- 诊断过多，结果已截断' : '';
  return `${lines.join('\n')}${suffix}`.trim();
}

export async function assertPluginAiPolicy(manifest: Record<string, unknown>, files: DraftFile[]): Promise<void> {
  const result = await checkPluginAiPolicy(manifest, files);
  if (result.ok) return;
  const error = new Error(`插件未通过平台 AI 使用政策检查：\n${policyDiagnosticMessage(result)}`) as Error & { code?: string };
  error.code = 'plugin_ai_policy_failed';
  throw error;
}

export async function assertInstalledPluginAiPolicy(
  installationId: string,
  pending: boolean,
): Promise<void> {
  const source = await tauriInvoke<{
    manifest: Record<string, unknown>;
    files: Array<{ path: string; content: string; binary: boolean }>;
  }>('read_installed_plugin_policy_source', { installationId, pending });
  await assertPluginAiPolicy(source.manifest, source.files);
}
