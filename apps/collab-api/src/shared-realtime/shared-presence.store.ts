import { createHash } from 'node:crypto';
import type { OnModuleDestroy } from '@nestjs/common';
import {
  SHARED_PRESENCE_TTL_MS,
  SharedPresenceMember,
  type SharedPresenceMember as SharedPresenceMemberValue,
} from '@lingfang/contract';
import IORedis from 'ioredis';
import type { SharedRealtimeConfig } from './shared-realtime.config';

export type SharedPresenceRoom = {
  teamId: string;
  namespaceId: string;
  namespaceGeneration: number;
};

export type SharedPresenceSession = {
  connectionId: string;
  userId: string;
  displayName: string;
  packageId: string | null;
  workflowReleaseId: string | null;
};

export interface SharedPresenceStore {
  join(
    room: SharedPresenceRoom,
    session: SharedPresenceSession
  ): Promise<SharedPresenceMemberValue>;
  heartbeat(
    room: SharedPresenceRoom,
    session: SharedPresenceSession
  ): Promise<SharedPresenceMemberValue | null>;
  leave(room: SharedPresenceRoom, connectionId: string): Promise<void>;
  list(room: SharedPresenceRoom): Promise<SharedPresenceMemberValue[]>;
  close(): Promise<void>;
}

type StoredPresence = SharedPresenceMemberValue & { connection_id: string };
type Clock = () => number;

export class DisabledSharedPresenceStore implements SharedPresenceStore {
  async join(): Promise<never> {
    throw new Error('shared_realtime_disabled');
  }
  async heartbeat(): Promise<null> {
    return null;
  }
  async leave(): Promise<void> {}
  async list(): Promise<SharedPresenceMemberValue[]> {
    return [];
  }
  async close(): Promise<void> {}
}

export class InMemorySharedPresenceStore implements SharedPresenceStore {
  private readonly rooms = new Map<
    string,
    Map<string, { member: SharedPresenceMemberValue; expiresAt: number }>
  >();

  constructor(private readonly now: Clock = Date.now) {}

  async join(
    room: SharedPresenceRoom,
    session: SharedPresenceSession
  ): Promise<SharedPresenceMemberValue> {
    const key = presenceRoomKey(room);
    const members = this.rooms.get(key) ?? new Map();
    this.rooms.set(key, members);
    const member = presenceMember(session, this.now());
    members.set(requireText(session.connectionId, 'connectionId'), {
      member,
      expiresAt: this.now() + SHARED_PRESENCE_TTL_MS,
    });
    return member;
  }

  async heartbeat(
    room: SharedPresenceRoom,
    session: SharedPresenceSession
  ): Promise<SharedPresenceMemberValue | null> {
    const members = this.rooms.get(presenceRoomKey(room));
    const connectionId = requireText(session.connectionId, 'connectionId');
    const existing = members?.get(connectionId);
    const now = this.now();
    if (!existing || existing.expiresAt <= now) {
      members?.delete(connectionId);
      return null;
    }
    const member = presenceMember(session, now);
    members!.set(connectionId, { member, expiresAt: now + SHARED_PRESENCE_TTL_MS });
    return member;
  }

  async leave(room: SharedPresenceRoom, connectionId: string): Promise<void> {
    const key = presenceRoomKey(room);
    const members = this.rooms.get(key);
    members?.delete(requireText(connectionId, 'connectionId'));
    if (members?.size === 0) this.rooms.delete(key);
  }

  async list(room: SharedPresenceRoom): Promise<SharedPresenceMemberValue[]> {
    const key = presenceRoomKey(room);
    const members = this.rooms.get(key);
    if (!members) return [];
    const now = this.now();
    for (const [connectionId, entry] of members) {
      if (entry.expiresAt <= now) members.delete(connectionId);
    }
    if (members.size === 0) this.rooms.delete(key);
    return [...members.values()].map((entry) => entry.member).sort(comparePresence);
  }

  async close(): Promise<void> {
    this.rooms.clear();
  }
}

type RedisPresenceClient = Pick<
  IORedis,
  'multi' | 'zrangebyscore' | 'zrange' | 'hmget' | 'eval' | 'quit' | 'disconnect' | 'status'
>;

export class RedisSharedPresenceStore implements SharedPresenceStore, OnModuleDestroy {
  private readonly redis: RedisPresenceClient;

  constructor(
    redisUrl: string,
    client?: RedisPresenceClient,
    private readonly now: Clock = Date.now
  ) {
    this.redis =
      client ??
      new IORedis(redisUrl, {
        lazyConnect: true,
        enableReadyCheck: true,
        maxRetriesPerRequest: 2,
        connectionName: 'lingfang-plugin-shared-realtime',
      });
    if (!client) (this.redis as IORedis).on('error', () => undefined);
  }

  async join(
    room: SharedPresenceRoom,
    session: SharedPresenceSession
  ): Promise<SharedPresenceMemberValue> {
    const now = this.now();
    const member = presenceMember(session, now);
    const stored: StoredPresence = {
      ...member,
      connection_id: requireText(session.connectionId, 'connectionId'),
    };
    const keys = redisPresenceKeys(room);
    await this.redis
      .multi()
      .hset(keys.members, stored.connection_id, JSON.stringify(stored))
      .zadd(keys.expiry, now + SHARED_PRESENCE_TTL_MS, stored.connection_id)
      .pexpire(keys.members, SHARED_PRESENCE_TTL_MS * 2)
      .pexpire(keys.expiry, SHARED_PRESENCE_TTL_MS * 2)
      .exec();
    return member;
  }

  async heartbeat(
    room: SharedPresenceRoom,
    session: SharedPresenceSession
  ): Promise<SharedPresenceMemberValue | null> {
    const now = this.now();
    const member = presenceMember(session, now);
    const stored: StoredPresence = {
      ...member,
      connection_id: requireText(session.connectionId, 'connectionId'),
    };
    const keys = redisPresenceKeys(room);
    const result = await this.redis.eval(
      HEARTBEAT_SCRIPT,
      2,
      keys.members,
      keys.expiry,
      stored.connection_id,
      String(now),
      String(now + SHARED_PRESENCE_TTL_MS),
      JSON.stringify(stored),
      String(SHARED_PRESENCE_TTL_MS * 2)
    );
    return Number(result) === 1 ? member : null;
  }

  async leave(room: SharedPresenceRoom, connectionId: string): Promise<void> {
    const keys = redisPresenceKeys(room);
    const id = requireText(connectionId, 'connectionId');
    await this.redis.multi().hdel(keys.members, id).zrem(keys.expiry, id).exec();
  }

  async list(room: SharedPresenceRoom): Promise<SharedPresenceMemberValue[]> {
    const keys = redisPresenceKeys(room);
    const now = this.now();
    const expired = await this.redis.zrangebyscore(keys.expiry, '-inf', now);
    if (expired.length > 0)
      await this.redis
        .multi()
        .zrem(keys.expiry, ...expired)
        .hdel(keys.members, ...expired)
        .exec();
    const live = await this.redis.zrange(keys.expiry, 0, -1);
    if (live.length === 0) return [];
    const payloads = await this.redis.hmget(keys.members, ...live);
    return payloads.flatMap((payload) => decodeStoredPresence(payload)).sort(comparePresence);
  }

  async close(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') this.redis.disconnect(false);
    else await this.redis.quit().catch(() => this.redis.disconnect(false));
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

export function createSharedPresenceStore(config: SharedRealtimeConfig): SharedPresenceStore {
  if (!config.enabled) return new DisabledSharedPresenceStore();
  if (config.transport === 'redis' && config.redisUrl)
    return new RedisSharedPresenceStore(config.redisUrl);
  return new InMemorySharedPresenceStore();
}

export function presenceRoomKey(room: SharedPresenceRoom): string {
  const teamId = requireText(room.teamId, 'teamId');
  const namespaceId = requireText(room.namespaceId, 'namespaceId');
  if (!Number.isSafeInteger(room.namespaceGeneration) || room.namespaceGeneration < 1)
    throw new Error('namespaceGeneration must be a positive integer');
  return `${teamId}\0${namespaceId}\0${room.namespaceGeneration}`;
}

function redisPresenceKeys(room: SharedPresenceRoom) {
  const digest = createHash('sha256').update(presenceRoomKey(room)).digest('hex');
  return {
    members: `lf:plugin-shared:presence:${digest}:members`,
    expiry: `lf:plugin-shared:presence:${digest}:expiry`,
  };
}

function presenceMember(session: SharedPresenceSession, now: number): SharedPresenceMemberValue {
  return SharedPresenceMember.parse({
    user_id: requireText(session.userId, 'userId'),
    display_name: requireText(session.displayName, 'displayName'),
    context: {
      package_id: optionalText(session.packageId, 'packageId'),
      workflow_release_id: optionalText(session.workflowReleaseId, 'workflowReleaseId'),
    },
    last_seen: new Date(now).toISOString(),
  });
}

function decodeStoredPresence(payload: string | null): SharedPresenceMemberValue[] {
  if (!payload) return [];
  try {
    const { connection_id: _connectionId, ...member } = JSON.parse(payload) as StoredPresence;
    const parsed = SharedPresenceMember.safeParse(member);
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}

function comparePresence(a: SharedPresenceMemberValue, b: SharedPresenceMemberValue): number {
  return a.user_id.localeCompare(b.user_id) || a.last_seen.localeCompare(b.last_seen);
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalText(value: string | null, name: string): string | null {
  return value === null ? null : requireText(value, name);
}

const HEARTBEAT_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
local expires = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not current or not expires or tonumber(expires) <= tonumber(ARGV[2]) then
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1
`;
