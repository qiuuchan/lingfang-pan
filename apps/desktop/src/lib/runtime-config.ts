import { tauriInvoke } from '@/lib/api';

export type RuntimeKind = 'python' | 'node' | 'ffmpeg' | 'chromium';
export type RuntimeSource = 'bundled';

export interface RuntimeStatus {
  available: boolean;
  source: RuntimeSource | null;
  version: string | null;
  binaryPath: string | null;
  error: string | null;
}

export type RuntimeStatusMap = Record<RuntimeKind, RuntimeStatus>;

export const RUNTIME_LABEL: Record<RuntimeKind, string> = {
  python: 'Python',
  node: 'Node.js',
  ffmpeg: 'FFmpeg',
  chromium: 'Chromium',
};

export function getRuntimeStatus() {
  return tauriInvoke<RuntimeStatusMap>('get_runtime_status');
}

export function formatVersion(label: string, version: string | null): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  const withoutLabel = trimmed.toLowerCase().startsWith(label.toLowerCase())
    ? trimmed.slice(label.length).trim()
    : trimmed;
  return withoutLabel.replace(/^v/i, '') || trimmed;
}
