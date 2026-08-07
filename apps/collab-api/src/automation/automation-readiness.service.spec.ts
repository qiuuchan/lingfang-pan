import { describe, expect, it, vi } from 'vitest';
import { resolveAutomationConfig } from './automation-config';
import { AutomationReadinessService } from './automation-readiness.service';

describe('AutomationReadinessService', () => {
  it('keeps automation dependency state separate from ordinary API readiness', async () => {
    const config = resolveAutomationConfig({
      AUTOMATION_ENABLED: 'true',
      AUTOMATION_PROCESS_ROLE: 'api',
    });
    const checkReadiness = vi.fn(async () => ({
      status: 'api_only' as const,
      redis: 'not_required' as const,
      persistence: 'not_required' as const,
      evictionPolicy: 'not_required' as const,
    }));
    const service = new AutomationReadinessService(
      config,
      { checkReadiness, listWorkerHeartbeats: vi.fn(async () => []) } as never,
      {} as never,
      {} as never
    );
    await expect(service.check()).resolves.toEqual({
      status: 'api_only',
      redis: 'not_required',
      persistence: 'not_required',
      evictionPolicy: 'not_required',
      processRole: 'api',
      workers: { required: false, status: 'not_required', count: 0, latest_age_ms: null },
    });
  });
});
