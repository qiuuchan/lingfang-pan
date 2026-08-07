import { describe, expect, it, vi } from 'vitest';
import { PluginRegistryService } from './plugin-registry.service';

const digest = (value: string) => value.repeat(64);
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const target = (releaseId: string, actionId: string) => ({
  package_id: `package-${releaseId}`,
  release_id: releaseId,
  sha256: digest(releaseId === 'child-release' ? 'c' : 'l'),
  action_id: actionId,
  action_contract_version: '1.0.0',
  action_surface_sha256: digest(releaseId === 'child-release' ? 'd' : 'm'),
});

describe('nested workflow publish freeze', () => {
  it('embeds the exact child subplan and counts the expanded immutable DAG', async () => {
    const childDefinition = {
      definition_version: '1',
      input_schema: schema,
      output_schema: schema,
      nodes: [
        {
          node_id: 'leaf',
          declared_version_range: '^1.0.0',
          target: target('leaf-release', 'render'),
          depends_on: [],
          input_bindings: [],
          retry_limit: 0,
        },
      ],
      output_bindings: [],
    };
    const childNodeProjection = {
      nodeId: 'leaf',
      declaredVersionRange: '^1.0.0',
      packageId: 'package-leaf-release',
      releaseId: 'leaf-release',
      sha256: digest('l'),
      actionId: 'render',
      actionContractVersion: '1.0.0',
      actionSurfaceSha256: digest('m'),
      executionSemantics: 'read_only',
      cloudCapable: true,
      retryLimit: 0,
      dependsOn: [],
      inputBindings: [],
    };
    const childAction = {
      action_id: 'default',
      action_contract_version: '1.0.0',
      action_surface_sha256: digest('d'),
      input_schema: schema,
      output_schema: schema,
      execution_semantics: 'read_only',
      cloud_capable: true,
    };
    const prisma = {
      pluginRelease: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id === 'child-release')
            return {
              id: 'child-release',
              packageId: 'package-child-release',
              sha256: digest('c'),
              status: 'PUBLISHED',
              actionSurfaceManifest: [childAction],
              workflowRelease: {
                pluginReleaseId: 'child-release',
                definitionSha256: digest('e'),
                definitionJson: childDefinition,
                maxParallelism: 1,
                nodes: [childNodeProjection],
              },
            };
          if (where.id === 'leaf-release')
            return {
              id: 'leaf-release',
              packageId: 'package-leaf-release',
              sha256: digest('l'),
              status: 'PUBLISHED',
              actionSurfaceManifest: [],
              workflowRelease: null,
            };
          return null;
        }),
      },
    };
    const service = new PluginRegistryService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never
    );
    const definition = {
      definition_version: '1',
      input_schema: schema,
      output_schema: schema,
      nodes: [
        {
          node_id: 'child',
          declared_version_range: '^1.0.0',
          target: target('child-release', 'default'),
          depends_on: [],
          input_bindings: [],
          retry_limit: 0,
        },
      ],
      output_bindings: [],
    };
    const manifest = {
      id: 'root.workflow',
      version: '1.0.0',
      actions: [
        {
          action_id: 'default',
          input_schema: schema,
          output_schema: schema,
          execution_semantics: 'read_only',
          cloud_capable: true,
        },
      ],
    };

    const snapshot = await (service as any).resolveWorkflowSnapshot(definition, manifest);

    expect(snapshot.expandedNodeCount).toBe(2);
    expect(snapshot.workflowSubplans).toEqual([
      expect.objectContaining({
        workflow_release_id: 'child-release',
        workflow_release_sha256: digest('c'),
        nodes: [
          expect.objectContaining({
            node_id: 'leaf',
            target: expect.objectContaining({ release_id: 'leaf-release' }),
          }),
        ],
      }),
    ]);
  });
});
