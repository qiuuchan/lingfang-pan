import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import IORedis from 'ioredis';
import { AppError } from '../common';
import type { AutomationConfig } from '../automation/automation-config';
import { automationRedisConnectionName } from '../automation/automation-queue';
import { AUTOMATION_CONFIG } from '../automation/automation.tokens';
import { PrismaService } from '../prisma.service';

export const CLOUD_QUOTA_REDIS = Symbol('CLOUD_QUOTA_REDIS');

type QuotaRedis = Pick<IORedis, 'eval' | 'quit' | 'disconnect'>;
type InvocationQuotaTarget = { id: string; teamId: string; releaseId: string; actionId: string };
type DeploymentQuota = { id: string; maxConcurrency: number; rateLimitPerMinute: number; timeoutMs: number };

const ACQUIRE_LUA = `
local lease_key = KEYS[1]
local rate_key = KEYS[2]
local now_ms = tonumber(ARGV[1])
local expires_ms = tonumber(ARGV[2])
local max_concurrency = tonumber(ARGV[3])
local rate_limit = tonumber(ARGV[4])
local member = ARGV[5]
redis.call('ZREMRANGEBYSCORE', lease_key, '-inf', now_ms)
if redis.call('ZCARD', lease_key) >= max_concurrency then return 0 end
local current_rate = tonumber(redis.call('GET', rate_key) or '0')
if current_rate >= rate_limit then return -1 end
redis.call('INCR', rate_key)
redis.call('PEXPIRE', rate_key, 61000)
redis.call('ZADD', lease_key, expires_ms, member)
redis.call('PEXPIRE', lease_key, math.max(61000, expires_ms - now_ms + 10000))
return 1
`;

@Injectable()
export class CloudExecutionQuotaService implements OnModuleDestroy {
  private redis: QuotaRedis | null;
  private ownsRedis = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTOMATION_CONFIG) private readonly config: AutomationConfig,
    @Optional() @Inject(CLOUD_QUOTA_REDIS) redis?: QuotaRedis,
  ) { this.redis = redis ?? null; }

  async assertInvocationQuota(invocation: InvocationQuotaTarget): Promise<void> {
    const minuteStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const [teamActive, actionActive, teamUsage, actionUsage] = await Promise.all([
      this.prisma.actionInvocation.count({ where: { teamId: invocation.teamId, cloudDeploymentId: { not: null }, status: { in: ['AUTHORIZED', 'RUNNING'] } } }),
      this.prisma.actionInvocation.count({ where: { teamId: invocation.teamId, releaseId: invocation.releaseId, actionId: invocation.actionId, cloudDeploymentId: { not: null }, status: { in: ['AUTHORIZED', 'RUNNING'] } } }),
      this.prisma.cloudUsageEvent.count({ where: { teamId: invocation.teamId, occurredAt: { gte: minuteStart } } }),
      this.prisma.cloudUsageEvent.count({ where: { teamId: invocation.teamId, releaseId: invocation.releaseId, actionId: invocation.actionId, occurredAt: { gte: minuteStart } } }),
    ]);
    if (teamActive > this.config.teamMaxActiveInvocations
      || actionActive > this.config.actionMaxActiveInvocations
      || teamUsage >= this.config.teamMaxUsagePerMinute
      || actionUsage >= this.config.actionMaxUsagePerMinute) {
      throw new AppError(429, 'cloud_quota_exceeded', 'Cloud 团队或 action 配额已用尽');
    }
  }

  async acquireEndpoint(deployment: DeploymentQuota, invocationId: string): Promise<() => Promise<void>> {
    const redis = this.redisClient();
    const now = Date.now();
    const leaseKey = `${this.config.redisPrefix}:quota:endpoint:${deployment.id}:leases`;
    const rateKey = `${this.config.redisPrefix}:quota:endpoint:${deployment.id}:minute:${Math.floor(now / 60_000)}`;
    const result = Number(await redis.eval(ACQUIRE_LUA, 2, leaseKey, rateKey, now, now + deployment.timeoutMs + 10_000, deployment.maxConcurrency, deployment.rateLimitPerMinute, invocationId));
    if (result !== 1) throw new AppError(429, 'cloud_quota_exceeded', result === 0 ? 'Cloud endpoint 并发已满' : 'Cloud endpoint 速率配额已用尽');
    return async () => { await redis.eval("return redis.call('ZREM', KEYS[1], ARGV[1])", 1, leaseKey, invocationId).catch(() => undefined); };
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis || !this.ownsRedis) return;
    await this.redis.quit().catch(() => this.redis?.disconnect(false));
  }

  private redisClient(): QuotaRedis {
    if (this.redis) return this.redis;
    if (!this.config.enabled || !this.config.redisUrl) throw new AppError(503, 'automation_redis_unavailable', 'Cloud 配额 Redis 不可用');
    const client = new IORedis(this.config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectionName: automationRedisConnectionName('cloud-quota', this.config.redisPrefix),
    });
    client.on('error', () => undefined);
    this.redis = client;
    this.ownsRedis = true;
    return client;
  }
}
