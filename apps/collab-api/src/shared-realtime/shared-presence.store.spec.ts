import { describe, expect, it } from 'vitest';
import { SHARED_PRESENCE_HEARTBEAT_MS, SHARED_PRESENCE_TTL_MS } from '@lingfang/contract';
import {
  DisabledSharedPresenceStore,
  InMemorySharedPresenceStore,
  presenceRoomKey,
} from './shared-presence.store';

const room = { teamId: 'team-1', namespaceId: 'namespace-1', namespaceGeneration: 2 };
const session = {
  connectionId: 'socket-1',
  userId: 'user-1',
  displayName: 'Lin',
  packageId: 'package-1',
  workflowReleaseId: null,
};

describe('shared presence store', () => {
  it('uses the contract heartbeat and TTL cadence', () => {
    expect(SHARED_PRESENCE_HEARTBEAT_MS).toBe(30_000);
    expect(SHARED_PRESENCE_TTL_MS).toBe(90_000);
  });

  it('binds presence to team, namespace and generation rooms', async () => {
    let now = Date.parse('2026-07-16T00:00:00.000Z');
    const store = new InMemorySharedPresenceStore(() => now);
    await store.join(room, session);
    expect(await store.list(room)).toHaveLength(1);
    expect(await store.list({ ...room, teamId: 'team-2' })).toEqual([]);
    expect(await store.list({ ...room, namespaceGeneration: 3 })).toEqual([]);

    now += SHARED_PRESENCE_HEARTBEAT_MS;
    expect(await store.heartbeat(room, session)).not.toBeNull();
    expect((await store.list(room))[0]?.last_seen).toBe('2026-07-16T00:00:30.000Z');
  });

  it('expires members at 90 seconds and does not reopen them on heartbeat', async () => {
    let now = 0;
    const store = new InMemorySharedPresenceStore(() => now);
    await store.join(room, session);
    now = SHARED_PRESENCE_TTL_MS;
    expect(await store.list(room)).toEqual([]);
    expect(await store.heartbeat(room, session)).toBeNull();
  });

  it('removes only the exact connection on leave', async () => {
    const store = new InMemorySharedPresenceStore(() => 0);
    await store.join(room, session);
    await store.join(room, { ...session, connectionId: 'socket-2', userId: 'user-2' });
    await store.leave(room, session.connectionId);
    expect((await store.list(room)).map((member) => member.user_id)).toEqual(['user-2']);
  });

  it('keeps disabled realtime fail-closed without affecting reads', async () => {
    const store = new DisabledSharedPresenceStore();
    await expect(store.join(room, session)).rejects.toThrow('shared_realtime_disabled');
    await expect(store.list(room)).resolves.toEqual([]);
  });

  it('rejects malformed room identities', () => {
    expect(() => presenceRoomKey({ ...room, namespaceGeneration: 0 })).toThrow(/positive integer/);
    expect(() => presenceRoomKey({ ...room, teamId: ' ' })).toThrow(/teamId is required/);
  });
});
