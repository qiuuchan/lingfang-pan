import { describe, expect, it, vi } from 'vitest';
import { InMemorySharedPresenceStore } from './shared-presence.store';
import { SharedRealtimeBroadcaster } from './shared-realtime-broadcaster';
import { SharedRealtimeGateway } from './shared-realtime.gateway';

function socket() {
  return {
    id: 'socket-1',
    data: {},
    emit: vi.fn(),
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    handshake: { auth: {}, headers: {} },
  } as any;
}

describe('SharedRealtimeGateway', () => {
  it('joins, heartbeats and leaves an exact generation room', async () => {
    const store = new InMemorySharedPresenceStore(() => 0);
    const authContext = {
      userId: 'user-1', teamId: 'team-1', displayName: 'Lin', invocationId: 'inv-1',
      packageId: 'pkg-1', releaseId: 'rel-1', releaseSha256: 'a'.repeat(64), actionId: 'act',
      actionContractVersion: '1.0.0', actionSurfaceSha256: 'b'.repeat(64), workflowReleaseId: null,
    };
    const authenticator = {
      authenticate: vi.fn(async () => authContext),
      authorizeRoom: vi.fn(async () => ({ teamId: 'team-1', namespaceId: 'ns-1', namespaceGeneration: 2 })),
      presenceSession: vi.fn((connectionId: string) => ({
        connectionId, userId: 'user-1', displayName: 'Lin', packageId: 'pkg-1', workflowReleaseId: null,
      })),
    };
    const broadcaster = new SharedRealtimeBroadcaster();
    const namespace = { to: vi.fn(() => ({ emit: vi.fn() })) } as any;
    const gateway = new SharedRealtimeGateway(store, authenticator as any, broadcaster, { apply: vi.fn() } as any);
    gateway.afterInit(namespace);
    (gateway as any).namespace = namespace;
    const client = socket();

    await gateway.handleConnection(client);
    await gateway.join(client, { namespace_id: 'ns-1', namespace_generation: 2 });
    expect(client.join).toHaveBeenCalledOnce();
    expect((await store.list({ teamId: 'team-1', namespaceId: 'ns-1', namespaceGeneration: 2 }))).toHaveLength(1);

    await gateway.heartbeat(client);
    expect(client.emit).not.toHaveBeenCalledWith('shared:error', expect.anything());
    await gateway.leave(client);
    expect(await store.list({ teamId: 'team-1', namespaceId: 'ns-1', namespaceGeneration: 2 })).toEqual([]);
  });

  it('rejects malformed rooms without joining transport rooms', async () => {
    const client = socket();
    client.data.auth = { userId: 'u' };
    const gateway = new SharedRealtimeGateway(
      new InMemorySharedPresenceStore(),
      {} as any,
      new SharedRealtimeBroadcaster(),
      {} as any,
    );
    await gateway.join(client, { namespace_id: 'ns', namespace_generation: 0, extra: true });
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('shared:error', { code: 'shared_realtime_room_invalid' });
  });

  it('disconnects unauthenticated sockets without leaking verifier errors', async () => {
    const client = socket();
    const gateway = new SharedRealtimeGateway(
      new InMemorySharedPresenceStore(),
      { authenticate: vi.fn(async () => { throw new Error('private detail'); }) } as any,
      new SharedRealtimeBroadcaster(),
      {} as any,
    );
    await gateway.handleConnection(client);
    expect(client.emit).toHaveBeenCalledWith('shared:error', { code: 'shared_realtime_error' });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});
