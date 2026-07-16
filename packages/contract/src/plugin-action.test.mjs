import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActionErrorCode,
  ActionInvocationKind,
  ActionTarget,
  ArtifactRefV1,
  CreateActionInvocationRequest,
  PluginAction,
  PluginActionDependency,
  satisfiesActionVersionRange,
  canonicalPluginActionSurfaceJson,
} from './plugin-action.ts';
import { PluginManifest } from './plugin.ts';
// Keep this test executable under Node's native ESM resolver; the barrel has
// historical extensionless exports used by bundlers, while direct contract
// modules include .ts extensions as required by the package runtime tests.

const objectSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  required: ['prompt'],
  additionalProperties: false,
};

const imageAction = {
  action_id: 'generate_image',
  name: 'Generate image',
  action_contract_version: '1.0.0',
  input_schema: objectSchema,
  output_schema: {
    type: 'object',
    properties: { image: { $ref: 'lingfang://schemas/artifact-ref/v1' } },
    required: ['image'],
    additionalProperties: false,
  },
  execution_semantics: 'idempotent',
  handler: { entry: 'actions/image.mjs', export: 'run' },
};

const exactTarget = {
  package_id: 'media',
  release_id: 'release-1',
  sha256: 'a'.repeat(64),
  action_id: 'generate_image',
  action_contract_version: '1.0.0',
  action_surface_sha256: 'b'.repeat(64),
};

test('old manifests remain valid and default action declarations are empty', () => {
  const manifest = PluginManifest.parse({ id: 'old', name: 'Old', version: '1.0.0', entry: 'index.html' });
  assert.deepEqual(manifest.actions, []);
  assert.deepEqual(manifest.action_dependencies, []);
});

test('manifest accepts multiple actions and dependencies with runtime-safe handlers', () => {
  const manifest = PluginManifest.parse({
    id: 'media', name: 'Media', version: '1.0.0', entry: 'index.html', runtime_type: 'client',
    actions: [imageAction, { ...imageAction, action_id: 'default', name: 'Default', handler: { entry: 'actions/default.mjs', export: 'run' } }],
    action_dependencies: [{ dependency_id: 'video_generator', package_id: 'pkg-1', release_version_range: '^1.0.0', action_id: 'generate_video', action_contract_version_range: '^1.0.0' }],
  });
  assert.equal(manifest.actions.length, 2);
  assert.equal(manifest.action_dependencies[0].dependency_id, 'video_generator');
});

test('action IDs, dependencies and exact targets are bounded', () => {
  assert.equal(PluginAction.safeParse({ ...imageAction, action_id: 'Bad ID' }).success, false);
  assert.equal(PluginActionDependency.safeParse({ dependency_id: 'dep', package_id: 'p', release_version_range: 'not-a-range', action_id: 'a', action_contract_version_range: '^1.0.0' }).success, false);
  assert.equal(ActionTarget.safeParse({ package_id: 'p', release_id: 'r', sha256: 'A'.repeat(64), action_id: 'a', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) }).success, false);
  assert.equal(ActionTarget.safeParse({ package_id: 'p', release_id: 'r', sha256: 'a'.repeat(64), action_id: 'a', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) }).success, true);
});

test('action dependency ranges share one bounded matcher across hosts', () => {
  assert.equal(satisfiesActionVersionRange('2.3.0', '^2.0.0'), true);
  assert.equal(satisfiesActionVersionRange('3.0.0', '^2.0.0'), false);
  assert.equal(satisfiesActionVersionRange('0.2.7', '^0.2.3'), true);
  assert.equal(satisfiesActionVersionRange('0.3.0', '^0.2.3'), false);
  assert.equal(satisfiesActionVersionRange('1.4.9', '~1.4.0'), true);
  assert.equal(satisfiesActionVersionRange('1.5.0', '~1.4.0'), false);
  assert.equal(satisfiesActionVersionRange('1.5.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(satisfiesActionVersionRange('1.5.0-beta.1', '>=1.0.0 <2.0.0'), false);
});

test('previewable actions are cloud-capable and never side effects', () => {
  assert.equal(PluginAction.safeParse({ ...imageAction, cloud_capable: true, previewable: true }).success, true);
  assert.equal(PluginAction.safeParse({ ...imageAction, cloud_capable: false, previewable: true }).success, false);
  assert.equal(PluginAction.safeParse({ ...imageAction, cloud_capable: true, previewable: true, execution_semantics: 'side_effect' }).success, false);
});

test('restricted schema rejects regex, unknown keywords, open objects and remote refs', () => {
  const bad = (schema) => PluginAction.safeParse({ ...imageAction, input_schema: schema }).success;
  assert.equal(bad({ type: 'object', properties: {}, required: [], additionalProperties: false, pattern: '.*' }), false);
  assert.equal(bad({ type: 'object', properties: {}, required: [], additionalProperties: true }), false);
  assert.equal(bad({ type: 'object', properties: {}, required: [], additionalProperties: false, $ref: 'https://example.com/schema' }), false);
  assert.equal(bad({ type: 'string', minLength: 1 }), false);
  assert.equal(bad({ type: 'object', properties: { broken: null }, required: [], additionalProperties: false }), false);
});

test('surface projection is canonical and independent of property ordering', () => {
  const reordered = {
    ...imageAction,
    input_schema: {
      additionalProperties: false,
      required: ['prompt'],
      properties: { prompt: { maxLength: 1000, minLength: 1, type: 'string' } },
      type: 'object',
    },
  };
  assert.equal(canonicalPluginActionSurfaceJson('client', PluginAction.parse(imageAction)), canonicalPluginActionSurfaceJson('client', PluginAction.parse(reordered)));
});

test('artifact refs, execution kind and stable errors are explicit contracts', () => {
  assert.equal(ActionInvocationKind.parse('PREVIEW'), 'PREVIEW');
  assert.equal(ActionErrorCode.parse('action_runtime_unavailable'), 'action_runtime_unavailable');
  assert.equal(ArtifactRefV1.safeParse({ type: 'artifact_ref', artifact_id: 'a1', media_type: 'image/png', size_bytes: 42, sha256: 'a'.repeat(64), authorization: { scope: 'TEAM', team_id: 'team-1', handle: 'mac' } }).success, true);
  assert.equal(ArtifactRefV1.safeParse({ type: 'artifact_ref', artifact_id: 'a1', media_type: 'image/png', size_bytes: 42, sha256: 'a'.repeat(64), authorization: { scope: 'TEAM', team_id: 'team-1' } }).success, false);
});

test('nested invocation identity is bounded and exposes one portable call chain', () => {
  assert.equal(ActionErrorCode.parse('action_concurrency_exceeded'), 'action_concurrency_exceeded');
  const request = CreateActionInvocationRequest.parse({
    target: exactTarget,
    preview: false,
    input: {},
    request_idempotency_key: 'nested-1',
    deadline_at: '2099-01-01T00:00:00.000Z',
    caller: { kind: 'ACTION', id: 'parent-1' },
    parent_invocation_id: 'parent-1',
  });
  assert.equal(request.caller.kind, 'ACTION');
  assert.equal(request.parent_invocation_id, 'parent-1');
});
