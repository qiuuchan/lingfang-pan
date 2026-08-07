import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpsRequest, createServer, type Server } from 'node:https';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma.service';
import {
  cloudRequestHeaders,
  signCloudResponse,
  verifyCloudRequestSignature,
  verifyCloudResponseSignature,
  type CloudRequestSignatureInput,
} from '../modules/cloud-signature';
import { AUTOMATION_CONTROL_QUEUE, BullMqAutomationQueueAdapter } from './automation-queue';
import { createAutomationWorkerConsumers } from './automation-worker-consumers';
import { resolveAutomationConfig } from './automation-config';

const enabled =
  process.env.WORKFLOW_E2E_DATABASE_URL &&
  process.env.AUTOMATION_TEST_REDIS_URL &&
  process.env.WORKFLOW_E2E_TLS_KEY &&
  process.env.WORKFLOW_E2E_TLS_CERT;
const integration = enabled ? describe : describe.skip;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  team: '10000000-0000-4000-8000-000000000002',
  workflowPackage: '10000000-0000-4000-8000-000000000003',
  workflowRelease: '10000000-0000-4000-8000-000000000004',
  schedule: '10000000-0000-4000-8000-000000000005',
  run: '10000000-0000-4000-8000-000000000006',
  namespace: '10000000-0000-4000-8000-000000000007',
};
const nodes = ['image', 'video', 'music', 'aggregate'] as const;
type NodeId = (typeof nodes)[number];
const packageId = (node: NodeId) => `20000000-0000-4000-8000-00000000000${nodes.indexOf(node) + 1}`;
const releaseId = (node: NodeId) => `30000000-0000-4000-8000-00000000000${nodes.indexOf(node) + 1}`;
const deploymentId = (node: NodeId) =>
  `40000000-0000-4000-8000-00000000000${nodes.indexOf(node) + 1}`;
const attemptId = (node: NodeId) => `50000000-0000-4000-8000-00000000000${nodes.indexOf(node) + 1}`;
const invocationId = (node: NodeId) =>
  `60000000-0000-4000-8000-00000000000${nodes.indexOf(node) + 1}`;
const artifactId = (node: NodeId) =>
  `70000000-0000-4000-8000-00000000000${nodes.indexOf(node) + 1}`;
const secret = 'deterministic-cloud-e2e-secret-32-bytes';
let prisma: PrismaService;
let server: Server;
let endpointPort = 0;
let prefix = '';
const closers: Array<() => Promise<unknown>> = [];
const config = (role: 'worker' | 'dispatcher') =>
  resolveAutomationConfig({
    AUTOMATION_ENABLED: 'true',
    CLOUD_MANUAL_ENABLED: 'true',
    SCHEDULES_ENABLED: 'true',
    AUTOMATION_PROCESS_ROLE: role,
    AUTOMATION_REDIS_URL: process.env.AUTOMATION_TEST_REDIS_URL,
    AUTOMATION_REDIS_PREFIX: prefix,
  });
async function waitFor(fn: () => Promise<boolean>, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('integration_timeout');
}
async function postSigned(node: NodeId, bodyValue: unknown) {
  const body = Buffer.from(JSON.stringify(bodyValue));
  const timestamp = Date.now();
  const nonce = randomUUID();
  const signatureInput: CloudRequestSignatureInput = {
    method: 'POST',
    canonicalPath: `/actions/${node}`,
    timestamp,
    nonce,
    invocationId: invocationId(node),
    target: {
      packageId: packageId(node),
      releaseId: releaseId(node),
      sha256: sha(node),
      actionId: node,
      actionContractVersion: '1.0.0',
      actionSurfaceSha256: sha(`${node}:surface`),
    },
    deploymentId: deploymentId(node),
    body,
  };
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port: endpointPort,
        path: `/actions/${node}`,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          ...cloudRequestHeaders(signatureInput, secret),
          'content-length': String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          const responseSignature = String(res.headers['x-lingfang-response-signature'] || '');
          expect(
            verifyCloudResponseSignature(
              {
                statusCode: res.statusCode || 0,
                timestamp,
                nonce,
                invocationId: invocationId(node),
                deploymentId: deploymentId(node),
                body: responseBody,
              },
              responseSignature,
              secret
            )
          ).toBe(true);
          resolve(JSON.parse(responseBody.toString()));
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

integration('workflow PostgreSQL + HTTPS + Redis integration', () => {
  beforeAll(async () => {
    process.env.DATABASE_PROVIDER = 'postgresql';
    process.env.DATABASE_URL = process.env.WORKFLOW_E2E_DATABASE_URL;
    prefix = `lf:workflow:e2e:${process.pid}-${randomUUID()}`;
    prisma = new PrismaService();
    await prisma.$connect();
    server = createServer(
      {
        key: readFileSync(process.env.WORKFLOW_E2E_TLS_KEY!),
        cert: readFileSync(process.env.WORKFLOW_E2E_TLS_CERT!),
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const node = req.url!.split('/').at(-1)! as NodeId;
          const input: CloudRequestSignatureInput = {
            method: 'POST',
            canonicalPath: req.url!,
            timestamp: Number(req.headers['x-lingfang-timestamp']),
            nonce: String(req.headers['x-lingfang-nonce']),
            invocationId: String(req.headers['x-lingfang-invocation-id']),
            target: {
              packageId: String(req.headers['x-lingfang-package-id']),
              releaseId: String(req.headers['x-lingfang-release-id']),
              sha256: String(req.headers['x-lingfang-release-sha256']),
              actionId: String(req.headers['x-lingfang-action-id']),
              actionContractVersion: String(req.headers['x-lingfang-contract-version']),
              actionSurfaceSha256: String(req.headers['x-lingfang-action-surface-sha256']),
            },
            deploymentId: String(req.headers['x-lingfang-deployment-id']),
            body,
          };
          expect(
            verifyCloudRequestSignature(input, String(req.headers['x-lingfang-signature']), secret)
          ).toBe(true);
          const output = Buffer.from(
            JSON.stringify({ node, artifact: artifactId(node), input: JSON.parse(body.toString()) })
          );
          res.setHeader('content-type', 'application/json');
          res.setHeader(
            'x-lingfang-response-signature',
            signCloudResponse(
              {
                statusCode: 200,
                timestamp: input.timestamp,
                nonce: input.nonce,
                invocationId: input.invocationId,
                deploymentId: input.deploymentId,
                body: output,
              },
              secret
            )
          );
          res.end(output);
        });
      }
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpointPort = (server.address() as { port: number }).port;
    await prisma.pluginSharedValueArtifact.deleteMany();
    await prisma.pluginSharedValue.deleteMany();
    await prisma.pluginSharedNamespace.deleteMany();
    await prisma.runtimeArtifactHold.deleteMany();
    await prisma.runtimeArtifactGrant.deleteMany();
    await prisma.runtimeArtifact.deleteMany();
    await prisma.workflowRunCloudBinding.deleteMany();
    await prisma.workflowStepAttempt.deleteMany();
    await prisma.actionInvocation.deleteMany();
    await prisma.workflowRun.deleteMany();
    await prisma.automationSchedule.deleteMany();
    await prisma.cloudActionRouting.deleteMany();
    await prisma.cloudActionDeployment.deleteMany();
    await prisma.workflowReleaseNode.deleteMany();
    await prisma.workflowRelease.deleteMany();
    await prisma.pluginRelease.deleteMany();
    await prisma.pluginPackage.deleteMany();
    await prisma.teamMembership.deleteMany();
    await prisma.team.deleteMany();
    await prisma.user.deleteMany();
    await prisma.user.create({
      data: {
        id: ids.user,
        email: 'workflow-e2e@example.test',
        displayName: 'Workflow E2E',
        passwordHash: 'not-used',
      },
    });
    await prisma.team.create({
      data: { id: ids.team, name: 'Workflow E2E', slug: 'workflow-e2e' },
    });
    await prisma.teamMembership.create({
      data: { userId: ids.user, teamId: ids.team, role: 'TEAM_ADMIN' },
    });
    for (const node of nodes) {
      await prisma.pluginPackage.create({
        data: {
          id: packageId(node),
          ownerTeamId: ids.team,
          authorUserId: ids.user,
          manifestId: `e2e.${node}`,
          name: node,
        },
      });
      await prisma.pluginRelease.create({
        data: {
          id: releaseId(node),
          packageId: packageId(node),
          version: '1.0.0',
          manifest: {},
          artifactKey: `e2e/${node}.lfplugin`,
          sha256: sha(node),
          sizeBytes: 1,
          status: 'PUBLISHED',
        },
      });
      await prisma.cloudActionDeployment.create({
        data: {
          id: deploymentId(node),
          teamId: ids.team,
          packageId: packageId(node),
          releaseId: releaseId(node),
          sha256: sha(node),
          actionId: node,
          actionContractVersion: '1.0.0',
          actionSurfaceSha256: sha(`${node}:surface`),
          environment: 'PRODUCTION',
          deploymentKey: 'stable',
          endpointUrl: `https://127.0.0.1:${endpointPort}/actions/${node}`,
          secretCiphertext: 'test-only',
          status: 'READY',
        },
      });
      await prisma.cloudActionRouting.create({
        data: {
          releaseId: releaseId(node),
          actionId: node,
          actionContractVersion: '1.0.0',
          actionSurfaceSha256: sha(`${node}:surface`),
          environment: 'PRODUCTION',
          stableDeploymentId: deploymentId(node),
          generation: 1,
        },
      });
    }
    await prisma.pluginPackage.create({
      data: {
        id: ids.workflowPackage,
        ownerTeamId: ids.team,
        authorUserId: ids.user,
        manifestId: 'e2e.workflow',
        name: 'media workflow',
      },
    });
    await prisma.pluginRelease.create({
      data: {
        id: ids.workflowRelease,
        packageId: ids.workflowPackage,
        version: '1.0.0',
        manifest: {},
        artifactKey: 'e2e/workflow.lfplugin',
        sha256: sha('workflow'),
        sizeBytes: 1,
        status: 'PUBLISHED',
      },
    });
    await prisma.workflowRelease.create({
      data: {
        pluginReleaseId: ids.workflowRelease,
        definitionVersion: '1',
        definitionSha256: sha('definition'),
        definitionJson: {},
        inputSchema: {},
        outputSchema: {},
        cloudEligible: true,
        expandedNodeCount: 4,
        maxParallelism: 2,
      },
    });
    await prisma.automationSchedule.create({
      data: {
        id: ids.schedule,
        teamId: ids.team,
        createdByUserId: ids.user,
        workflowReleaseId: ids.workflowRelease,
        workflowReleaseSha256: sha('workflow'),
        kind: 'ONCE',
        runAt: new Date(Date.now() + 60_000),
        inputJson: {},
        inputSchemaSha256: sha('{}'),
        generation: 1,
        schedulerKey: 'e2e-schedule-g1',
        status: 'ACTIVE',
      },
    });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled(closers.reverse().map((fn) => fn()));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prisma) await prisma.$disconnect();
  });
  it('persists signed routing, ledger, grants and shared result', async () => {
    let queue!: BullMqAutomationQueueAdapter;
    const completed = new Set<NodeId>();
    const publish = (node: NodeId) =>
      queue.publishAction({
        run_id: ids.run,
        attempt_id: attemptId(node),
        invocation_id: invocationId(node),
        plan_sha256: sha('plan'),
      });
    const schedule = {
      process: async () => {
        await prisma.workflowRun.create({
          data: {
            id: ids.run,
            teamId: ids.team,
            principalUserId: ids.user,
            workflowReleaseId: ids.workflowRelease,
            executionScope: 'PRODUCTION',
            executionTarget: 'CLOUD',
            status: 'RUNNING',
            requestScopeSha256: sha('scope'),
            idempotencyKey: 'schedule-occurrence',
            requestDigest: sha('request'),
            inputDigest: sha('{}'),
            rootLogicalExecutionId: ids.run,
            planSha256: sha('plan'),
            frozenPlan: {},
            input: {},
            policyRevision: 1,
            authorizationDecision: { allowed: true },
            triggerKind: 'SCHEDULE',
            deadlineAt: new Date(Date.now() + 60_000),
            resultRetainUntil: new Date(Date.now() + 3600_000),
            scheduleId: ids.schedule,
            scheduleGeneration: 1,
            occurrenceKey: 'occurrence-1',
            startedAt: new Date(),
            attempts: {
              create: nodes.map((node) => ({
                id: attemptId(node),
                nodeId: node,
                fullNodePath: node,
                attempt: 0,
                status: node === 'image' ? 'READY' : 'PENDING',
                requestKey: `request-${node}`,
                packageId: packageId(node),
                releaseId: releaseId(node),
                releaseSha256: sha(node),
                actionId: node,
                actionContractVersion: '1.0.0',
                actionSurfaceSha256: sha(`${node}:surface`),
                executionSemantics: 'idempotent',
                retryLimit: 0,
              })),
            },
            cloudBindings: {
              create: nodes.map((node) => ({
                nodePath: node,
                deploymentId: deploymentId(node),
                routingGeneration: 1,
                environment: 'PRODUCTION',
                policyDecisionId: 'allow-e2e',
              })),
            },
          },
        });
        await publish('image');
        return { outcome: 'CREATED' };
      },
    };
    const action = {
      process: async (job: { invocation_id: string }) => {
        const resolved = nodes.find((candidate) => invocationId(candidate) === job.invocation_id)!;
        const inputs =
          resolved === 'video' || resolved === 'music'
            ? [artifactId('image')]
            : resolved === 'aggregate'
              ? [artifactId('video'), artifactId('music')]
              : [];
        const response = await postSigned(resolved, { artifacts: inputs });
        await prisma.$transaction(async (tx) => {
          await tx.actionInvocation.create({
            data: {
              id: invocationId(resolved),
              teamId: ids.team,
              principalUserId: ids.user,
              kind: 'STANDARD',
              status: 'SUCCEEDED',
              packageId: packageId(resolved),
              releaseId: releaseId(resolved),
              releaseSha256: sha(resolved),
              actionId: resolved,
              actionContractVersion: '1.0.0',
              actionSurfaceSha256: sha(`${resolved}:surface`),
              callerKind: 'CLOUD',
              callerId: ids.run,
              requestId: `request-${resolved}`,
              requestScopeKey: sha(`scope-${resolved}`),
              requestIdempotencyKey: `idem-${resolved}`,
              policyRevision: 1,
              requiredOperations: ['invoke_action', 'execute_cloud'],
              input: { artifacts: inputs },
              inputSha256: sha(JSON.stringify(inputs)),
              output: response,
              outputSha256: sha(JSON.stringify(response)),
              cloudDeploymentId: deploymentId(resolved),
              cloudRoutingGeneration: 1,
              cloudEnvironment: 'PRODUCTION',
              deadlineAt: new Date(Date.now() + 60_000),
              startedAt: new Date(),
              completedAt: new Date(),
            },
          });
          await tx.workflowStepAttempt.update({
            where: { id: attemptId(resolved) },
            data: {
              status: 'SUCCEEDED',
              actionInvocationId: invocationId(resolved),
              output: response,
              completedAt: new Date(),
            },
          });
          await tx.runtimeArtifact.create({
            data: {
              id: artifactId(resolved),
              teamId: ids.team,
              creatorInvocationId: invocationId(resolved),
              executionKind: 'STANDARD',
              objectKey: `e2e/${artifactId(resolved)}`,
              mediaType:
                resolved === 'image'
                  ? 'image/png'
                  : resolved === 'music'
                    ? 'audio/mpeg'
                    : resolved === 'video'
                      ? 'video/mp4'
                      : 'application/json',
              sizeBytes: 1,
              sha256: sha(`artifact-${resolved}`),
              retainUntil: new Date(Date.now() + 3600_000),
            },
          });
          await tx.runtimeArtifactGrant.create({
            data: {
              artifactId: artifactId(resolved),
              executionKind: 'STANDARD',
              targetKind: 'WORKFLOW_RUN',
              targetId: resolved === 'aggregate' ? `${ids.run}:FINAL_OUTPUT` : ids.run,
              scopeDigest: sha(`grant-${resolved}`),
              subjectKey: sha(`subject-${resolved}`),
              expiresAt: new Date(Date.now() + 3600_000),
            },
          });
          await tx.runtimeArtifactHold.create({
            data: {
              artifactId: artifactId(resolved),
              executionKind: 'STANDARD',
              holderKind: 'WORKFLOW_RUN',
              holderId: `${ids.run}:${resolved}`,
              purpose: resolved === 'aggregate' ? 'FINAL_OUTPUT' : 'EDGE',
              scopeDigest: sha(`hold-${resolved}`),
              holderKey: sha(`holder-${resolved}`),
              retainUntil: new Date(Date.now() + 3600_000),
            },
          });
        });
        completed.add(resolved);
        if (resolved === 'image') await Promise.all([publish('video'), publish('music')]);
        if (
          (resolved === 'video' || resolved === 'music') &&
          completed.has('video') &&
          completed.has('music') &&
          !completed.has('aggregate')
        )
          await publish('aggregate');
        if (resolved === 'aggregate') {
          await prisma.pluginSharedNamespace.create({
            data: {
              id: ids.namespace,
              teamId: ids.team,
              ownerKind: 'WORKFLOW',
              ownerId: ids.workflowPackage,
              name: 'render',
            },
          });
          await prisma.pluginSharedValue.create({
            data: {
              namespaceId: ids.namespace,
              namespaceGeneration: 1,
              key: 'latest',
              valueJson: { run_id: ids.run, artifact_id: artifactId('aggregate') },
              schemaVersion: 1,
              valueBytes: 100,
              revision: 1n,
              createdByUserId: ids.user,
            },
          });
          await prisma.workflowRun.update({
            where: { id: ids.run },
            data: {
              status: 'SUCCEEDED',
              output: { artifact_id: artifactId('aggregate') },
              completedAt: new Date(),
            },
          });
        }
        return { outcome: 'SUCCEEDED' };
      },
    };
    const handles = createAutomationWorkerConsumers(config('worker'), {
      action: action as never,
      preview: { process: async () => ({}) } as never,
      schedule: schedule as never,
      control: { process: async () => ({}) } as never,
    });
    closers.push(async () => Promise.allSettled(handles.map((h) => h.close())));
    queue = new BullMqAutomationQueueAdapter(config('dispatcher'));
    closers.push(() => queue.close());
    const redis = new IORedis(process.env.AUTOMATION_TEST_REDIS_URL!, {
      maxRetriesPerRequest: null,
    });
    const control = new Queue(AUTOMATION_CONTROL_QUEUE, { connection: redis, prefix });
    closers.push(async () => {
      await control.close();
      await redis.quit();
    });
    await control.add(
      'schedule.once_fire',
      {
        schedule_id: ids.schedule,
        generation: 1,
        scheduler_key: 'e2e-schedule-g1',
        scheduled_for: new Date().toISOString(),
        occurrence_key: 'occurrence-1',
      },
      { jobId: 'workflow-postgres-e2e' }
    );
    await waitFor(
      async () =>
        (await prisma.workflowRun.findUnique({ where: { id: ids.run } }))?.status === 'SUCCEEDED'
    );
    expect(
      await prisma.workflowRunCloudBinding.count({
        where: { runId: ids.run, routingGeneration: 1 },
      })
    ).toBe(4);
    expect(
      await prisma.actionInvocation.count({ where: { callerId: ids.run, status: 'SUCCEEDED' } })
    ).toBe(4);
    expect(
      await prisma.runtimeArtifactGrant.count({
        where: { targetId: `${ids.run}:FINAL_OUTPUT`, revokedAt: null },
      })
    ).toBe(1);
    expect(
      await prisma.runtimeArtifactHold.count({
        where: { purpose: 'FINAL_OUTPUT', releasedAt: null },
      })
    ).toBe(1);
    expect(
      await prisma.pluginSharedValue.findUnique({
        where: { namespaceId_key: { namespaceId: ids.namespace, key: 'latest' } },
      })
    ).toMatchObject({ valueJson: { run_id: ids.run, artifact_id: artifactId('aggregate') } });
  }, 30_000);
});
