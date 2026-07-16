import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceQualityDailyScheduler, qualitySchedulerEnabled, qualitySchedulerInterval } from './marketplace-quality-daily.scheduler';

afterEach(() => {
  delete process.env.MARKETPLACE_QUALITY_DAILY_ENABLED;
  delete process.env.MARKETPLACE_QUALITY_DAILY_INTERVAL_MS;
});

describe('MarketplaceQualityDailyScheduler', () => {
  it('runs startup catch-up and keeps only one in-process daily pass active', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const runDaily = vi.fn().mockReturnValue(pending);
    const scheduler = new MarketplaceQualityDailyScheduler({ runDaily } as never);
    const first = scheduler.tick(new Date('2026-07-16T00:00:00Z'));
    const second = scheduler.tick(new Date('2026-07-16T01:00:00Z'));
    expect(runDaily).toHaveBeenCalledOnce();
    release({ processed: 1 });
    await expect(first).resolves.toEqual({ processed: 1 });
    await expect(second).resolves.toEqual({ processed: 1 });
  });

  it('supports an explicit disable switch and clamps invalid intervals', () => {
    expect(qualitySchedulerEnabled({ MARKETPLACE_QUALITY_DAILY_ENABLED: 'false' })).toBe(false);
    expect(qualitySchedulerEnabled({})).toBe(true);
    expect(qualitySchedulerInterval({ MARKETPLACE_QUALITY_DAILY_INTERVAL_MS: '1000' })).toBe(60 * 60 * 1000);
    expect(qualitySchedulerInterval({ MARKETPLACE_QUALITY_DAILY_INTERVAL_MS: '120000' })).toBe(120000);
  });
});

