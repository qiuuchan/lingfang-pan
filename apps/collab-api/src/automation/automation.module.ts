import { DynamicModule, Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { resolveAutomationConfig } from './automation-config';
import { AutomationOutboxDispatcher } from './automation-outbox-dispatcher';
import { AutomationOutboxService } from './automation-outbox.service';
import { createAutomationQueueAdapter } from './automation-queue';
import { AutomationReadinessService } from './automation-readiness.service';
import { AUTOMATION_CONFIG, AUTOMATION_QUEUE } from './automation.tokens';
import { CollabModule } from '../modules/collab.module';
import { AutomationWorkerConsumers } from './automation-worker-consumers';
import { AutomationControlProcessor } from './automation-control.processor';
import { AutomationReconcilerService } from './automation-reconciler.service';
import {
  AUTOMATION_SCHEDULER_PORT,
  AutomationSchedulerService,
  createAutomationSchedulerPort,
} from './automation-scheduler.service';
import { CloudAbortBus } from './cloud-abort-bus';

@Module({})
export class AutomationModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const config = resolveAutomationConfig(env);
    return {
      module: AutomationModule,
      imports: [CollabModule],
      providers: [
        PrismaService,
        { provide: AUTOMATION_CONFIG, useValue: config },
        { provide: AUTOMATION_QUEUE, useFactory: () => createAutomationQueueAdapter(config) },
        {
          provide: AUTOMATION_SCHEDULER_PORT,
          useFactory: () => createAutomationSchedulerPort(config),
        },
        AutomationOutboxService,
        AutomationOutboxDispatcher,
        AutomationReadinessService,
        AutomationSchedulerService,
        AutomationControlProcessor,
        AutomationReconcilerService,
        AutomationWorkerConsumers,
        { provide: CloudAbortBus, useFactory: () => new CloudAbortBus(config) },
      ],
      exports: [
        AUTOMATION_CONFIG,
        AUTOMATION_QUEUE,
        AutomationOutboxService,
        AutomationReadinessService,
        CloudAbortBus,
      ],
    };
  }
}
