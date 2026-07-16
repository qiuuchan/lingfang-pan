import { DynamicModule, Module } from '@nestjs/common';
import { CollabModule } from '../modules/collab.module';
import { createSharedPresenceStore } from './shared-presence.store';
import { resolveSharedRealtimeConfig } from './shared-realtime.config';
import { SharedRealtimeAuthenticator } from './shared-realtime-authenticator';
import { SharedRealtimeBroadcaster } from './shared-realtime-broadcaster';
import { SharedRealtimeGateway } from './shared-realtime.gateway';
import { SharedRealtimeOutboxPublisher } from './shared-realtime-outbox.publisher';
import { SharedRealtimeRedisAdapter } from './shared-realtime-redis-adapter';
import { SHARED_PRESENCE_STORE, SHARED_REALTIME_CONFIG } from './shared-realtime.tokens';

export { SHARED_PRESENCE_STORE, SHARED_REALTIME_CONFIG } from './shared-realtime.tokens';

@Module({})
export class SharedRealtimeModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const config = resolveSharedRealtimeConfig(env);
    const realtimeProviders = config.enabled
      ? [SharedRealtimeAuthenticator, SharedRealtimeBroadcaster, SharedRealtimeRedisAdapter, SharedRealtimeGateway, SharedRealtimeOutboxPublisher]
      : [];
    return {
      module: SharedRealtimeModule,
      imports: config.enabled ? [CollabModule] : [],
      providers: [
        { provide: SHARED_REALTIME_CONFIG, useValue: config },
        { provide: SHARED_PRESENCE_STORE, useFactory: () => createSharedPresenceStore(config) },
        ...realtimeProviders,
      ],
      exports: [SHARED_REALTIME_CONFIG, SHARED_PRESENCE_STORE],
    };
  }
}
