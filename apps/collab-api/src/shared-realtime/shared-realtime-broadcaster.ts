import { Injectable } from '@nestjs/common';
import { SharedRealtimeInvalidation } from '@lingfang/contract';
import { createHash } from 'node:crypto';
import type { Namespace } from 'socket.io';
import { presenceRoomKey, type SharedPresenceRoom } from './shared-presence.store';

export const SHARED_INVALIDATION_EVENT = 'shared:invalidate';
export const SHARED_PRESENCE_EVENT = 'presence:snapshot';

@Injectable()
export class SharedRealtimeBroadcaster {
  private namespace: Namespace | null = null;

  attach(namespace: Namespace): void {
    this.namespace = namespace;
  }

  roomName(room: SharedPresenceRoom): string {
    return `shared:${createHash('sha256').update(presenceRoomKey(room)).digest('hex')}`;
  }

  async invalidation(row: {
    teamId: string;
    namespaceId: string;
    namespaceGeneration: number;
    cursor: bigint;
    key: string;
    revision: bigint;
  }): Promise<void> {
    if (!this.namespace) throw new Error('shared_realtime_gateway_not_ready');
    const room = {
      teamId: row.teamId,
      namespaceId: row.namespaceId,
      namespaceGeneration: row.namespaceGeneration,
    };
    const event = SharedRealtimeInvalidation.parse({
      cursor: row.cursor.toString(),
      key: row.key,
      revision: row.revision.toString(),
    });
    this.namespace.to(this.roomName(room)).emit(SHARED_INVALIDATION_EVENT, event);
  }
}
