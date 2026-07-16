import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MarketplaceMetricKind, MarketplaceMetricSource } from '@lingfang/contract';
import { PrismaService } from '../prisma.service';
import { projectMarketplaceQualityGateTx } from './marketplace-quality-projection';

export type MarketplaceMetricFact = {
  idempotencyKey: string;
  kind: MarketplaceMetricKind;
  source: MarketplaceMetricSource;
  packageId: string;
  releaseId: string;
  teamId?: string | null;
  sourceRecordId: string;
  value?: number;
};

export type StoredMarketplaceMetric = MarketplaceMetricFact & {
  id: string;
  occurredAt: Date;
};

export interface MarketplaceMetricRepository {
  append(fact: MarketplaceMetricFact & { occurredAt: Date }): Promise<{ metric: StoredMarketplaceMetric; created: boolean }>;
}

export const MARKETPLACE_METRIC_REPOSITORY = Symbol('MARKETPLACE_METRIC_REPOSITORY');

@Injectable()
export class PrismaMarketplaceMetricRepository implements MarketplaceMetricRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async append(fact: MarketplaceMetricFact & { occurredAt: Date }): Promise<{ metric: StoredMarketplaceMetric; created: boolean }> {
    try {
      const create = (client: Prisma.TransactionClient | PrismaService) => client.marketplaceMetricEvent.create({ data: {
          idempotencyKey: fact.idempotencyKey,
          packageId: fact.packageId,
          releaseId: fact.releaseId,
          teamId: fact.teamId ?? null,
          kind: fact.kind,
          source: fact.source,
          sourceRecordId: fact.sourceRecordId,
          value: fact.value ?? null,
          occurredAt: fact.occurredAt,
        } });
      const securityFact = fact.kind === 'SECURITY_BLOCKED' || fact.kind === 'SECURITY_CLEARED';
      const row = securityFact
        ? await this.prisma.$transaction(async (tx) => {
            const created = await create(tx);
            await projectMarketplaceQualityGateTx(tx, fact.packageId, fact.kind, fact.occurredAt);
            return created;
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        : await create(this.prisma);
      return { metric: projectMetric(row), created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existing = await this.prisma.marketplaceMetricEvent.findUnique({ where: { idempotencyKey: fact.idempotencyKey } });
      if (!existing) throw error;
      const metric = projectMetric(existing);
      if (!sameMetric(metric, fact)) throw new Error('marketplace_metric_idempotency_conflict');
      return { metric, created: false };
    }
  }
}

const ALLOWED_SOURCE_BY_KIND: Readonly<Record<MarketplaceMetricKind, readonly MarketplaceMetricSource[]>> = {
  INSTALL_SUCCEEDED: ['DESKTOP_HOST', 'REGISTRY'],
  RUN_SUCCEEDED: ['DESKTOP_HOST', 'CLOUD_RUNTIME', 'WORKFLOW_RUNTIME'],
  RUN_FAILED: ['DESKTOP_HOST', 'CLOUD_RUNTIME', 'WORKFLOW_RUNTIME'],
  RATING_CHANGED: ['REGISTRY'],
  PURCHASED: ['COMMERCE'],
  REFUNDED: ['COMMERCE'],
  SECURITY_BLOCKED: ['SECURITY'],
  SECURITY_CLEARED: ['SECURITY'],
};

@Injectable()
export class MarketplaceMetricRecorder {
  constructor(@Inject(MARKETPLACE_METRIC_REPOSITORY) private readonly repository: MarketplaceMetricRepository) {}

  async record(fact: MarketplaceMetricFact, now = new Date()): Promise<{ metric: StoredMarketplaceMetric; created: boolean }> {
    validateFact(fact);
    if (Number.isNaN(now.getTime())) throw new Error('marketplace_metric_invalid_time');
    // occurredAt is intentionally server-owned. Callers cannot backdate facts into a quality window.
    return this.repository.append({ ...fact, occurredAt: new Date(now) });
  }
}

function projectMetric(row: {
  id: string; idempotencyKey: string; kind: MarketplaceMetricKind; source: MarketplaceMetricSource;
  packageId: string; releaseId: string; teamId: string | null; sourceRecordId: string; value: number | null; occurredAt: Date;
}): StoredMarketplaceMetric {
  return {
    id: row.id, idempotencyKey: row.idempotencyKey, kind: row.kind, source: row.source,
    packageId: row.packageId, releaseId: row.releaseId, teamId: row.teamId,
    sourceRecordId: row.sourceRecordId, value: row.value ?? undefined, occurredAt: row.occurredAt,
  };
}

function sameMetric(metric: StoredMarketplaceMetric, fact: MarketplaceMetricFact): boolean {
  return metric.kind === fact.kind && metric.source === fact.source && metric.packageId === fact.packageId
    && metric.releaseId === fact.releaseId && metric.teamId === (fact.teamId ?? null)
    && metric.sourceRecordId === fact.sourceRecordId && metric.value === fact.value;
}

function validateFact(fact: MarketplaceMetricFact): void {
  for (const [name, value, max] of [
    ['idempotency_key', fact.idempotencyKey, 256], ['package_id', fact.packageId, 128],
    ['release_id', fact.releaseId, 128], ['source_record_id', fact.sourceRecordId, 256],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`marketplace_metric_invalid_${name}`);
  }
  if (!ALLOWED_SOURCE_BY_KIND[fact.kind]?.includes(fact.source)) throw new Error('marketplace_metric_source_mismatch');
  if (fact.value !== undefined && (!Number.isInteger(fact.value) || fact.value < 0)) throw new Error('marketplace_metric_invalid_value');
  if ((fact.kind === 'RATING_CHANGED') && (fact.value === undefined || fact.value < 1 || fact.value > 5)) throw new Error('marketplace_metric_invalid_rating');
  if (fact.kind !== 'RATING_CHANGED' && fact.value !== undefined) throw new Error('marketplace_metric_unexpected_value');
}
