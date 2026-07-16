import { describe, expect, it, vi } from 'vitest';
import { SharedRealtimeOutboxPublisher } from './shared-realtime-outbox.publisher';

describe('SharedRealtimeOutboxPublisher', () => {
  it('broadcasts an invalidation before CAS marking the row published', async () => {
    const row = {
      id: 'o1', teamId: 't1', namespaceId: 'n1', namespaceGeneration: 1,
      cursor: 3n, key: 'draft', revision: 7n,
    };
    const prisma = {
      sharedStateOutbox: {
        findMany: vi.fn(async () => [row]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const broadcaster = { invalidation: vi.fn(async () => undefined) };
    const publisher = new SharedRealtimeOutboxPublisher(
      { enabled: true, transport: 'memory', redisUrl: null },
      prisma as any,
      broadcaster as any,
    );
    await expect(publisher.publishOnce()).resolves.toEqual({ delivered: 1, failed: 0, stale: 0 });
    expect(broadcaster.invalidation).toHaveBeenCalledWith(row);
    expect(prisma.sharedStateOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'o1', publishedAt: null },
    }));
  });

  it('keeps failed rows unpublished and increments attempts for retry', async () => {
    const prisma = {
      sharedStateOutbox: {
        findMany: vi.fn(async () => [{
          id: 'o1', teamId: 't1', namespaceId: 'n1', namespaceGeneration: 1,
          cursor: 3n, key: 'draft', revision: 7n,
        }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const publisher = new SharedRealtimeOutboxPublisher(
      { enabled: true, transport: 'memory', redisUrl: null }, prisma as any,
      { invalidation: vi.fn(async () => { throw new Error('down'); }) } as any,
    );
    await expect(publisher.publishOnce()).resolves.toEqual({ delivered: 0, failed: 1, stale: 0 });
    expect(prisma.sharedStateOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', publishedAt: null }, data: { attempts: { increment: 1 } },
    });
  });
});
