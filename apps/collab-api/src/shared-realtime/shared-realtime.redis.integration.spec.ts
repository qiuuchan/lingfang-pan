import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { SHARED_PRESENCE_TTL_MS } from '@lingfang/contract';
import { SHARED_PRESENCE_STORE, SHARED_REALTIME_CONFIG } from './shared-realtime.tokens';
import { RedisSharedPresenceStore, type SharedPresenceRoom } from './shared-presence.store';
import { SharedRealtimeAuthenticator, type SharedRealtimeAuthContext } from './shared-realtime-authenticator';
import { SHARED_INVALIDATION_EVENT, SHARED_PRESENCE_EVENT, SharedRealtimeBroadcaster } from './shared-realtime-broadcaster';
import { SharedRealtimeGateway } from './shared-realtime.gateway';
import { SharedRealtimeRedisAdapter } from './shared-realtime-redis-adapter';

const TEST_REDIS_URL = process.env.SHARED_REALTIME_TEST_REDIS_URL?.trim();
const redisDescribe = TEST_REDIS_URL ? describe : describe.skip;
const roomV1: SharedPresenceRoom = { teamId: 'team-shared', namespaceId: 'namespace-shared', namespaceGeneration: 1 };
const roomV2: SharedPresenceRoom = { ...roomV1, namespaceGeneration: 2 };
const clock = { now: Date.parse('2026-07-16T00:00:00.000Z') };

type PresenceSnapshot = {
  namespace_id: string;
  namespace_generation: number;
  members: Array<{ user_id: string }>;
};

type TestNode = {
  app: INestApplication;
  url: string;
  presence: RedisSharedPresenceStore;
  broadcaster: SharedRealtimeBroadcaster;
  gateway: SharedRealtimeGateway;
};

let admin: IORedis;
const nodes: TestNode[] = [];
const sockets: ClientSocket[] = [];

redisDescribe('shared realtime Redis multi-instance integration', () => {
  beforeAll(async () => {
    admin = new IORedis(TEST_REDIS_URL!, { connectionName: 'lingfang-shared-realtime-integration-admin' });
    admin.on('error', () => undefined);
    expect(await admin.ping()).toBe('PONG');
    await admin.flushdb();
  }, 20_000);

  afterAll(async () => {
    for (const socket of sockets) {
      if (socket.connected) socket.emit('shared:leave');
    }
    await delay(150);
    for (const socket of sockets.splice(0)) socket.disconnect();
    await delay(150);
    for (const node of nodes.splice(0).reverse()) {
      const server = (node.gateway as unknown as { namespace: { server: { close: (callback: () => void) => void } } }).namespace.server;
      await new Promise<void>((resolve) => server.close(resolve));
      // @socket.io/redis-adapter v8 does not await ioredis unsubscribe promises
      // from adapter.close(); let them settle before the provider quits clients.
      await delay(100);
      await node.app.close();
    }
    await admin.flushdb();
    await admin.quit().catch(() => admin.disconnect(false));
  }, 20_000);

  it('shares presence and invalidations across two live Nest/Socket.IO instances', async () => {
    const [nodeA, nodeB] = await Promise.all([createNode(), createNode()]);
    nodes.push(nodeA, nodeB);

    const clientA = await connect(nodeA.url, 'user-a');
    const clientB = await connect(nodeB.url, 'user-b');
    sockets.push(clientA, clientB);

    const firstA = nextEvent<PresenceSnapshot>(clientA, SHARED_PRESENCE_EVENT,
      (snapshot) => memberIds(snapshot).join(',') === 'user-a');
    clientA.emit('shared:join', roomPayload(roomV1));
    await firstA;

    const bothOnA = nextEvent<PresenceSnapshot>(clientA, SHARED_PRESENCE_EVENT,
      (snapshot) => memberIds(snapshot).join(',') === 'user-a,user-b');
    const bothOnB = nextEvent<PresenceSnapshot>(clientB, SHARED_PRESENCE_EVENT,
      (snapshot) => memberIds(snapshot).join(',') === 'user-a,user-b');
    clientB.emit('shared:join', roomPayload(roomV1));
    await Promise.all([bothOnA, bothOnB]);

    const invalidationOnB = nextEvent<{ cursor: string; key: string; revision: string }>(
      clientB,
      SHARED_INVALIDATION_EVENT,
      (event) => event.cursor === '41',
    );
    await nodeA.broadcaster.invalidation({
      teamId: roomV1.teamId,
      namespaceId: roomV1.namespaceId,
      namespaceGeneration: roomV1.namespaceGeneration,
      cursor: 41n,
      key: 'asset',
      revision: 73n,
    });
    await expect(invalidationOnB).resolves.toEqual({ cursor: '41', key: 'asset', revision: '73' });

    const generationTwo = await connect(nodeB.url, 'user-generation-2');
    sockets.push(generationTwo);
    const generationTwoSnapshot = nextEvent<PresenceSnapshot>(generationTwo, SHARED_PRESENCE_EVENT,
      (snapshot) => memberIds(snapshot).join(',') === 'user-generation-2');
    generationTwo.emit('shared:join', roomPayload(roomV2));
    await generationTwoSnapshot;
    const generationTwoInvalidations: unknown[] = [];
    generationTwo.on(SHARED_INVALIDATION_EVENT, (event) => generationTwoInvalidations.push(event));
    const secondInvalidationOnB = nextEvent<{ cursor: string }>(clientB, SHARED_INVALIDATION_EVENT,
      (event) => event.cursor === '42');
    await nodeA.broadcaster.invalidation({
      teamId: roomV1.teamId,
      namespaceId: roomV1.namespaceId,
      namespaceGeneration: roomV1.namespaceGeneration,
      cursor: 42n,
      key: 'asset',
      revision: 74n,
    });
    await secondInvalidationOnB;
    await delay(200);
    expect(generationTwoInvalidations).toEqual([]);
    await expect(nodeA.presence.list(roomV2)).resolves.toMatchObject([{ user_id: 'user-generation-2' }]);

    clientA.disconnect();
    const afterDisconnect = await heartbeatUntil(clientB, (snapshot) => memberIds(snapshot).join(',') === 'user-b');
    expect(memberIds(afterDisconnect)).toEqual(['user-b']);

    const reconnectedA = await connect(nodeA.url, 'user-a');
    sockets.push(reconnectedA);
    const reconnectedOnB = nextEvent<PresenceSnapshot>(clientB, SHARED_PRESENCE_EVENT,
      (snapshot) => memberIds(snapshot).join(',') === 'user-a,user-b');
    reconnectedA.emit('shared:join', roomPayload(roomV1));
    await reconnectedOnB;

    const expiring = await connect(nodeA.url, 'user-expiring');
    sockets.push(expiring);
    const expiringJoined = nextEvent<PresenceSnapshot>(expiring, SHARED_PRESENCE_EVENT,
      (snapshot) => memberIds(snapshot).includes('user-expiring'));
    expiring.emit('shared:join', roomPayload(roomV1));
    await expiringJoined;
    clock.now += SHARED_PRESENCE_TTL_MS + 1;
    const expiredError = nextEvent<{ code: string }>(expiring, 'shared:error', (event) => event.code === 'shared_presence_expired');
    expiring.emit('shared:heartbeat');
    await expect(expiredError).resolves.toEqual({ code: 'shared_presence_expired' });
    await expect(nodeB.presence.list(roomV1)).resolves.toEqual([]);
  }, 30_000);
});

async function createNode(): Promise<TestNode> {
  const presence = new RedisSharedPresenceStore(TEST_REDIS_URL!, undefined, () => clock.now);
  const fakeAuthenticator = {
    async authenticate(socket: { handshake: { auth?: Record<string, unknown> } }): Promise<SharedRealtimeAuthContext> {
      const userId = String(socket.handshake.auth?.user_id || '').trim();
      if (!userId) throw Object.assign(new Error('unauthorized'), { code: 'shared_realtime_unauthorized' });
      return {
        userId,
        teamId: roomV1.teamId,
        displayName: userId,
        invocationId: `invocation-${userId}`,
        packageId: `package-${userId}`,
        releaseId: `release-${userId}`,
        releaseSha256: 'a'.repeat(64),
        actionId: 'shared.run',
        actionContractVersion: '1.0.0',
        actionSurfaceSha256: 'b'.repeat(64),
        workflowReleaseId: null,
      };
    },
    async authorizeRoom(principal: SharedRealtimeAuthContext, room: Pick<SharedPresenceRoom, 'namespaceId' | 'namespaceGeneration'>) {
      return { teamId: principal.teamId, ...room };
    },
    presenceSession(connectionId: string, principal: SharedRealtimeAuthContext) {
      return {
        connectionId,
        userId: principal.userId,
        displayName: principal.displayName,
        packageId: principal.packageId,
        workflowReleaseId: principal.workflowReleaseId,
      };
    },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: SHARED_REALTIME_CONFIG, useValue: { enabled: true, transport: 'redis', redisUrl: TEST_REDIS_URL } },
      { provide: SHARED_PRESENCE_STORE, useValue: presence },
      { provide: SharedRealtimeAuthenticator, useValue: fakeAuthenticator },
      SharedRealtimeBroadcaster,
      SharedRealtimeRedisAdapter,
      SharedRealtimeGateway,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  return {
    app,
    url: (await app.getUrl()).replace(/\/$/u, ''),
    presence,
    broadcaster: app.get(SharedRealtimeBroadcaster),
    gateway: app.get(SharedRealtimeGateway),
  };
}

async function connect(baseUrl: string, userId: string): Promise<ClientSocket> {
  const socket = io(`${baseUrl}/plugin-shared`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { user_id: userId },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`socket connect timeout: ${userId}`)), 10_000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

function nextEvent<T>(socket: ClientSocket, event: string, predicate: (payload: T) => boolean, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function heartbeatUntil(socket: ClientSocket, predicate: (snapshot: PresenceSnapshot) => boolean): Promise<PresenceSnapshot> {
  const deadline = Date.now() + 10_000;
  let last: PresenceSnapshot | null = null;
  while (Date.now() < deadline) {
    const snapshot = nextEvent<PresenceSnapshot>(socket, SHARED_PRESENCE_EVENT, () => true, 2_000);
    socket.emit('shared:heartbeat');
    last = await snapshot;
    if (predicate(last)) return last;
    await delay(25);
  }
  throw new Error(`presence did not converge: ${JSON.stringify(last)}`);
}

function roomPayload(room: SharedPresenceRoom) {
  return { namespace_id: room.namespaceId, namespace_generation: room.namespaceGeneration };
}

function memberIds(snapshot: PresenceSnapshot): string[] {
  return snapshot.members.map((member) => member.user_id).sort();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
