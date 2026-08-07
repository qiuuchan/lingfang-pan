// ReadinessService 单测：覆盖 health/ready 探活逻辑。
// 参考 release.service.spec.ts：Mock PrismaService，不连真实 DB。
//  - db_up：$queryRaw 成功 → {status:ok, db:up}。
//  - db_down：$queryRaw 抛错 → {status:degraded, db:down}（不向外抛，探活容错）。
import { describe, expect, it, vi } from 'vitest';
import { ReadinessService } from './health.controller';

function mockPrisma(queryRawImpl: () => Promise<unknown>) {
  return { $queryRaw: vi.fn(queryRawImpl) };
}

describe('ReadinessService health/ready', () => {
  it('$queryRaw 成功时返 {status:ok, db:up}', async () => {
    const prisma = mockPrisma(async () => [{ '?column?': 1 }]);
    const service = new ReadinessService(
      prisma as never,
      {
        check: vi.fn().mockResolvedValue({
          status: 'api_only',
          redis: 'not_required',
          persistence: 'not_required',
          evictionPolicy: 'not_required',
          processRole: 'api',
        }),
      } as never
    );
    const result = await service.check();
    expect(result).toEqual({
      status: 'ok',
      db: 'up',
      automation: expect.objectContaining({ status: 'api_only' }),
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('$queryRaw 抛错时返 {status:degraded, db:down}（不向外抛）', async () => {
    const prisma = mockPrisma(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const service = new ReadinessService(prisma as never, { check: vi.fn() } as never);
    const result = await service.check();
    // 探活必须容错：DB 不可达不应让进程崩溃，仅标记降级供编排系统摘除流量。
    expect(result).toEqual({ status: 'degraded', db: 'down', automation: null });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
