import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MarketplaceQualityService } from './marketplace-quality.service';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class MarketplaceQualityDailyScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<unknown>;

  constructor(@Inject(MarketplaceQualityService) private readonly quality: MarketplaceQualityService) {}

  onModuleInit(): void {
    if (!qualitySchedulerEnabled(process.env)) return;
    void this.tick(new Date());
    const interval = qualitySchedulerInterval(process.env);
    this.timer = setInterval(() => { void this.tick(new Date()); }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(factWatermark = new Date()) {
    if (this.running) return this.running;
    this.running = this.quality.runDaily(factWatermark).finally(() => { this.running = undefined; });
    return this.running;
  }
}

export function qualitySchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MARKETPLACE_QUALITY_DAILY_ENABLED !== 'false';
}

export function qualitySchedulerInterval(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.MARKETPLACE_QUALITY_DAILY_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : DEFAULT_INTERVAL_MS;
}

