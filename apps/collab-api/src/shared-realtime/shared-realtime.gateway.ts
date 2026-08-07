import { Inject, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { SharedPresenceSnapshot } from '@lingfang/contract';
import type { Namespace, Socket } from 'socket.io';
import { SHARED_PRESENCE_STORE } from './shared-realtime.tokens';
import { SHARED_REALTIME_NAMESPACE } from './shared-realtime.config';
import type {
  SharedPresenceRoom,
  SharedPresenceSession,
  SharedPresenceStore,
} from './shared-presence.store';
import {
  SharedRealtimeAuthenticator,
  type SharedRealtimeAuthContext,
} from './shared-realtime-authenticator';
import { SHARED_PRESENCE_EVENT, SharedRealtimeBroadcaster } from './shared-realtime-broadcaster';
import { SharedRealtimeRedisAdapter } from './shared-realtime-redis-adapter';

type SharedSocketData = {
  auth?: SharedRealtimeAuthContext;
  room?: SharedPresenceRoom;
  presence?: SharedPresenceSession;
};
type SharedSocket = Socket<
  Record<string, never>,
  Record<string, (...args: unknown[]) => void>,
  Record<string, never>,
  SharedSocketData
>;

@WebSocketGateway({ namespace: SHARED_REALTIME_NAMESPACE, transports: ['websocket'], cors: false })
export class SharedRealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer() private namespace!: Namespace;
  private initializedNamespace: Namespace | null = null;

  constructor(
    @Inject(SHARED_PRESENCE_STORE) private readonly presence: SharedPresenceStore,
    @Inject(SharedRealtimeAuthenticator)
    private readonly authenticator: SharedRealtimeAuthenticator,
    @Inject(SharedRealtimeBroadcaster) private readonly broadcaster: SharedRealtimeBroadcaster,
    @Inject(SharedRealtimeRedisAdapter) private readonly redisAdapter: SharedRealtimeRedisAdapter
  ) {}

  afterInit(namespace: Namespace): void {
    this.initializedNamespace = namespace;
    this.broadcaster.attach(namespace);
  }

  async onModuleInit(): Promise<void> {
    if (!this.initializedNamespace)
      throw new Error('shared realtime namespace failed to initialize');
    await this.redisAdapter.apply(this.initializedNamespace);
  }

  async handleConnection(socket: SharedSocket): Promise<void> {
    try {
      socket.data.auth = await this.authenticator.authenticate(socket);
    } catch (error) {
      socket.emit('shared:error', publicError(error));
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: SharedSocket): Promise<void> {
    await this.leaveCurrent(socket, false);
  }

  @SubscribeMessage('shared:join')
  async join(@ConnectedSocket() socket: SharedSocket, @MessageBody() body: unknown): Promise<void> {
    try {
      const auth = requireAuth(socket);
      const requested = parseRoom(body);
      const room = await this.authenticator.authorizeRoom(auth, requested);
      await this.leaveCurrent(socket, true);
      const session = this.authenticator.presenceSession(socket.id, auth);
      await socket.join(this.broadcaster.roomName(room));
      await this.presence.join(room, session);
      socket.data.room = room;
      socket.data.presence = session;
      await this.broadcastPresence(room);
    } catch (error) {
      socket.emit('shared:error', publicError(error));
    }
  }

  @SubscribeMessage('shared:heartbeat')
  async heartbeat(@ConnectedSocket() socket: SharedSocket): Promise<void> {
    try {
      requireAuth(socket);
      const room = socket.data.room;
      const session = socket.data.presence;
      if (!room || !session) throw codedError('shared_realtime_not_joined');
      const member = await this.presence.heartbeat(room, session);
      if (!member) {
        socket.data.room = undefined;
        socket.data.presence = undefined;
        await socket.leave(this.broadcaster.roomName(room));
        throw codedError('shared_presence_expired');
      }
      await this.broadcastPresence(room);
    } catch (error) {
      socket.emit('shared:error', publicError(error));
    }
  }

  @SubscribeMessage('shared:leave')
  async leave(@ConnectedSocket() socket: SharedSocket): Promise<void> {
    await this.leaveCurrent(socket, true);
  }

  private async leaveCurrent(socket: SharedSocket, broadcast: boolean): Promise<void> {
    const room = socket.data.room;
    const session = socket.data.presence;
    socket.data.room = undefined;
    socket.data.presence = undefined;
    if (!room || !session) return;
    await this.presence.leave(room, session.connectionId);
    await socket.leave(this.broadcaster.roomName(room));
    if (broadcast) await this.broadcastPresence(room);
  }

  private async broadcastPresence(room: SharedPresenceRoom): Promise<void> {
    const snapshot = SharedPresenceSnapshot.parse({
      namespace_id: room.namespaceId,
      namespace_generation: room.namespaceGeneration,
      members: await this.presence.list(room),
    });
    this.namespace.to(this.broadcaster.roomName(room)).emit(SHARED_PRESENCE_EVENT, snapshot);
  }
}

function parseRoom(
  value: unknown
): Pick<SharedPresenceRoom, 'namespaceId' | 'namespaceGeneration'> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw codedError('shared_realtime_room_invalid');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['namespace_id', 'namespace_generation'].includes(key))) {
    throw codedError('shared_realtime_room_invalid');
  }
  if (typeof input.namespace_id !== 'string' || !input.namespace_id.trim())
    throw codedError('shared_realtime_room_invalid');
  if (!Number.isSafeInteger(input.namespace_generation) || Number(input.namespace_generation) < 1) {
    throw codedError('shared_realtime_room_invalid');
  }
  return {
    namespaceId: input.namespace_id.trim(),
    namespaceGeneration: Number(input.namespace_generation),
  };
}

function requireAuth(socket: SharedSocket): SharedRealtimeAuthContext {
  if (!socket.data.auth) throw codedError('shared_realtime_unauthorized');
  return socket.data.auth;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function publicError(error: unknown): { code: string } {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'shared_realtime_error';
  return { code };
}
