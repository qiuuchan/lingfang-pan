import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export const AUTOMATION_OUTBOX_MAX_ATTEMPTS = 12;
export const AUTOMATION_OUTBOX_LEASE_MS = 30_000;

export function automationOutboxBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(60 * 60 * 1000, 1_000 * (2 ** exponent));
}

export type ClaimedAutomationOutbox = {
  id: string;
  kind: 'UPSERT_SCHEDULE' | 'REMOVE_SCHEDULE' | 'ENQUEUE_RUN' | 'ENQUEUE_ACTION' | 'CANCEL_RUN';
  aggregateId: string;
  generation: number;
  payload: unknown;
  attempts: number;
  lockedUntil: Date;
};

@Injectable()
export class AutomationOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(workerId: string, limit = 25, now = new Date()): Promise<ClaimedAutomationOutbox[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const lockedUntil = new Date(now.getTime() + AUTOMATION_OUTBOX_LEASE_MS);
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.automationOutbox.findMany({
        where: {
          availableAt: { lte: now },
          OR: [
            { status: 'PENDING' },
            { status: 'PROCESSING', lockedUntil: { lt: now } },
          ],
        },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
        take: boundedLimit,
        select: { id: true },
      });
      const claimed: ClaimedAutomationOutbox[] = [];
      for (const candidate of candidates) {
        const result = await tx.automationOutbox.updateMany({
          where: {
            id: candidate.id,
            availableAt: { lte: now },
            OR: [
              { status: 'PENDING' },
              { status: 'PROCESSING', lockedUntil: { lt: now } },
            ],
          },
          data: {
            status: 'PROCESSING',
            lockedBy: workerId,
            lockedUntil,
            attempts: { increment: 1 },
          },
        });
        if (result.count !== 1) continue;
        const row = await tx.automationOutbox.findUniqueOrThrow({ where: { id: candidate.id } });
        claimed.push({
          id: row.id,
          kind: row.kind,
          aggregateId: row.aggregateId,
          generation: row.generation,
          payload: row.payload,
          attempts: row.attempts,
          lockedUntil: row.lockedUntil!,
        });
      }
      return claimed;
    });
  }

  async complete(id: string, workerId: string): Promise<boolean> {
    const result = await this.prisma.automationOutbox.updateMany({
      where: { id, status: 'PROCESSING', lockedBy: workerId },
      data: { status: 'DONE', lockedBy: null, lockedUntil: null, lastErrorCode: '' },
    });
    return result.count === 1;
  }

  async fail(id: string, workerId: string, errorCode: string, now = new Date()): Promise<'RETRY' | 'DEAD' | 'STALE'> {
    const current = await this.prisma.automationOutbox.findFirst({
      where: { id, status: 'PROCESSING', lockedBy: workerId },
      select: { attempts: true },
    });
    if (!current) return 'STALE';
    const dead = current.attempts >= AUTOMATION_OUTBOX_MAX_ATTEMPTS;
    const result = await this.prisma.automationOutbox.updateMany({
      where: { id, status: 'PROCESSING', lockedBy: workerId, attempts: current.attempts },
      data: dead ? {
        status: 'FAILED',
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: errorCode.slice(0, 120),
      } : {
        status: 'PENDING',
        availableAt: new Date(now.getTime() + automationOutboxBackoffMs(current.attempts)),
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: errorCode.slice(0, 120),
      },
    });
    if (result.count !== 1) return 'STALE';
    return dead ? 'DEAD' : 'RETRY';
  }
}
