import type { CliProbeResult } from '@/lib/plugin-draft';

export function probeWith(stdout: string, success = true): CliProbeResult {
  return {
    tool: 'claude',
    model: 'sonnet',
    success,
    stdoutTail: stdout,
    commandPreview: ['claude', '--print'],
    transcriptPath: '/tmp/t.jsonl',
    sessionId: 's1',
    diagnostics: [],
  };
}
