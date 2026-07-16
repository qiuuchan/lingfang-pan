import { describe, expect, it, vi } from 'vitest';
import { resolveAutomationConfig } from '../automation/automation-config';
import { CloudExecutionQuotaService } from './cloud-execution-quota.service';

describe('CloudExecutionQuotaService', () => {
  const config = resolveAutomationConfig({ AUTOMATION_ENABLED: 'true', AUTOMATION_PROCESS_ROLE: 'worker', AUTOMATION_REDIS_URL: 'redis://example/15', AUTOMATION_TEAM_MAX_ACTIVE_RUNS: '2', AUTOMATION_ACTION_MAX_ACTIVE_INVOCATIONS: '3', AUTOMATION_TEAM_MAX_USAGE_PER_MINUTE: '5', AUTOMATION_ACTION_MAX_USAGE_PER_MINUTE: '2' });

  it('rejects team/action usage with the stable cloud_quota_exceeded code', async () => {
    const prisma = { actionInvocation: { count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1) }, cloudUsageEvent: { count: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2) } } as any;
    const service = new CloudExecutionQuotaService(prisma, config, {} as any);
    await expect(service.assertInvocationQuota({ id: 'i1', teamId: 't1', releaseId: 'r1', actionId: 'a1' })).rejects.toMatchObject({ code: 'cloud_quota_exceeded' });
  });

  it('uses one atomic Redis acquisition and releases the endpoint lease', async () => {
    const redis = { eval: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1), quit: vi.fn(), disconnect: vi.fn() } as any;
    const service = new CloudExecutionQuotaService({} as any, config, redis);
    const release = await service.acquireEndpoint({ id: 'd1', maxConcurrency: 2, rateLimitPerMinute: 10, timeoutMs: 30_000 }, 'i1');
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('ZREMRANGEBYSCORE'), 2, expect.stringContaining('d1:leases'), expect.stringContaining('d1:minute:'), expect.any(Number), expect.any(Number), 2, 10, 'i1');
    await release();
    expect(redis.eval).toHaveBeenLastCalledWith(expect.stringContaining('ZREM'), 1, expect.stringContaining('d1:leases'), 'i1');
  });
});

