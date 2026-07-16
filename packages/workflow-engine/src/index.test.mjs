import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildWorkflowClosure, buildWorkflowPlan, materializeBindings, readyWorkflowNodes, reduceWorkflowRun } from './index.ts';
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const target = (id) => ({ package_id: `pkg-${id}`, release_id: `release-${id}`, sha256: 'a'.repeat(64), action_id: id, action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) });
const node = (id, depends_on = [], input_bindings = []) => ({ node_id: id, declared_version_range: '^1.0.0', target: target(id), depends_on, input_bindings, retry_limit: 0 });
const definition = { definition_version: '1', input_schema: schema, output_schema: schema, nodes: [node('image'), node('video', ['image'], [{ target_pointer: '/image', source: { kind: 'node_output', node_id: 'image', source_pointer: '/asset' } }]), node('music', ['image'])], output_bindings: [] };
test('plans image then video and music in parallel', () => { const result = buildWorkflowPlan(definition); assert.deepEqual(result.diagnostics, []); assert.deepEqual(result.plan.ready_sets, [['image'], ['music', 'video']]); assert.deepEqual(readyWorkflowNodes(definition, { image: 'SUCCEEDED', video: 'PENDING', music: 'PENDING' }), ['music', 'video']); });
test('rejects cycles and hidden node-output dependencies', () => { const cycle = { ...definition, nodes: [node('image', ['video']), node('video', ['image'])] }; assert.equal(buildWorkflowPlan(cycle).diagnostics[0].code, 'workflow_cycle_detected'); const hidden = { ...definition, nodes: [node('image'), node('video', [], [{ target_pointer: '/x', source: { kind: 'node_output', node_id: 'image', source_pointer: '/x' } }])] }; assert.equal(buildWorkflowPlan(hidden).diagnostics[0].code, 'workflow_mapping_invalid'); });
test('rejects reserved runtime identities in literals', () => { const unsafe = { ...definition, nodes: [node('image', [], [{ target_pointer: '/x', source: { kind: 'literal', value: { nested: { type: 'artifact_ref' } } } }])] }; assert.equal(buildWorkflowPlan(unsafe).diagnostics[0].code, 'workflow_mapping_invalid'); });
test('materializes explicit JSON pointer bindings without expressions', () => { const value = materializeBindings([{ target_pointer: '/asset/id', source: { kind: 'node_output', node_id: 'image', source_pointer: '/asset_id' } }, { target_pointer: '/prompt', source: { kind: 'workflow_input', source_pointer: '/prompt' } }], { prompt: 'demo' }, { image: { asset_id: 'a1' } }); assert.deepEqual(value, { asset: { id: 'a1' }, prompt: 'demo' }); });
test('retries safe nodes and closes for side effects or cancellation', () => { const base = { status: 'RUNNING', nodes: { image: { status: 'RUNNING', attempt: 0, retry_limit: 2, execution_semantics: 'read_only' }, video: { status: 'PENDING', attempt: 0, retry_limit: 0, execution_semantics: 'side_effect' } } }; const retry = reduceWorkflowRun(base, { type: 'step_failed', node_id: 'image', retryable: true }); assert.equal(retry.state.nodes.image.status, 'READY'); assert.equal(retry.effects[0].type, 'retry'); const sideEffect = reduceWorkflowRun({ ...base, nodes: { ...base.nodes, image: { ...base.nodes.image, execution_semantics: 'side_effect' } } }, { type: 'step_failed', node_id: 'image', retryable: true }); assert.equal(sideEffect.state.status, 'FAILING'); assert.equal(sideEffect.state.nodes.video.status, 'SKIPPED'); const canceled = reduceWorkflowRun(base, { type: 'cancel_requested' }); assert.equal(canceled.state.status, 'CANCELING'); });

const frozenNode = (nodeId, releaseId) => ({ ...node(nodeId), target: { ...target(nodeId), release_id: releaseId }, execution_semantics: 'read_only', cloud_capable: true });
const frozenWorkflow = (releaseId, childReleaseIds = []) => ({
  workflow_release_id: releaseId,
  workflow_release_sha256: 'c'.repeat(64),
  definition_sha256: 'd'.repeat(64),
  max_parallelism: 1,
  nodes: childReleaseIds.length ? childReleaseIds.map((child, index) => frozenNode(`child_${index}`, child)) : [frozenNode('leaf', `action-${releaseId}`)],
  output_bindings: [],
});

test('freezes exact nested workflow closure and rejects direct/indirect recursion with full path', async () => {
  const direct = frozenWorkflow('workflow-a', ['workflow-a']);
  const directResult = await buildWorkflowClosure(direct, async (releaseId) => releaseId === 'workflow-a' ? direct : null);
  assert.equal(directResult.diagnostics[0].code, 'workflow_recursion');
  assert.deepEqual(directResult.diagnostics[0].release_path, ['workflow-a', 'workflow-a']);

  const a = frozenWorkflow('workflow-a', ['workflow-b']);
  const b = frozenWorkflow('workflow-b', ['workflow-c']);
  const c = frozenWorkflow('workflow-c', ['workflow-a']);
  const releases = new Map([[a.workflow_release_id, a], [b.workflow_release_id, b], [c.workflow_release_id, c]]);
  const indirect = await buildWorkflowClosure(a, async (releaseId) => releases.get(releaseId) ?? null);
  assert.equal(indirect.diagnostics[0].code, 'workflow_recursion');
  assert.deepEqual(indirect.diagnostics[0].release_path, ['workflow-a', 'workflow-b', 'workflow-c', 'workflow-a']);
});

test('rejects nested workflow depth and expanded node limits deterministically', async () => {
  const releases = new Map();
  for (let index = 0; index <= 5; index += 1) releases.set(`workflow-${index}`, frozenWorkflow(`workflow-${index}`, index < 5 ? [`workflow-${index + 1}`] : []));
  const depth = await buildWorkflowClosure(releases.get('workflow-0'), async (releaseId) => releases.get(releaseId) ?? null);
  assert.equal(depth.diagnostics[0].code, 'workflow_limit_exceeded');
  assert.deepEqual(depth.diagnostics[0].release_path, ['workflow-0', 'workflow-1', 'workflow-2', 'workflow-3', 'workflow-4', 'workflow-5']);

  const wideChild = { ...frozenWorkflow('workflow-wide'), nodes: Array.from({ length: 64 }, (_, index) => frozenNode(`leaf_${index}`, `action-${index}`)) };
  const root = { ...frozenWorkflow('workflow-root'), nodes: [frozenNode('left', 'workflow-wide'), frozenNode('right', 'workflow-wide')] };
  const expanded = await buildWorkflowClosure(root, async (releaseId) => releaseId === 'workflow-wide' ? wideChild : null);
  assert.equal(expanded.diagnostics[0].code, 'workflow_limit_exceeded');
  assert.equal(expanded.expanded_node_count, 130);
});

const artifact = (artifactId, mediaType, digestCharacter) => ({
  type: 'artifact_ref',
  artifact_id: artifactId,
  media_type: mediaType,
  size_bytes: 1024,
  sha256: digestCharacter.repeat(64),
  authorization: { scope: 'TEAM', team_id: 'team-fixture', handle: `fixture:${artifactId}` },
});

test('deterministic E2E fans image ArtifactRef out to video/music, then fans in and maps final output', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/image-video-music-aggregate.json', import.meta.url), 'utf8'));
  const { definition, workflow_input: workflowInput } = fixture;
  const planned = buildWorkflowPlan(definition);
  assert.deepEqual(planned.diagnostics, []);
  assert.deepEqual(planned.plan.ready_sets, [['image'], ['music', 'video'], ['aggregate']]);

  const refs = {
    image: artifact('artifact-image', 'image/png', '1'),
    video: artifact('artifact-video', 'video/mp4', '2'),
    music: artifact('artifact-music', 'audio/mpeg', '3'),
    package: artifact('artifact-package', 'application/vnd.lingfang.media-package+json', '4'),
  };
  const states = Object.fromEntries(definition.nodes.map((item) => [item.node_id, 'PENDING']));
  const outputs = {};
  const inputs = {};
  const executionBatches = [];
  const exactTargetTrace = [];

  const handlers = {
    image(input) {
      assert.deepEqual(input, { prompt: '日落时分的海边灯塔' });
      return { image: refs.image };
    },
    video(input) {
      assert.deepEqual(input, { image: refs.image, duration_seconds: 8 });
      return { video: refs.video };
    },
    music(input) {
      assert.deepEqual(input, { cover_image: refs.image, mood: 'cinematic' });
      return { music: refs.music };
    },
    aggregate(input) {
      assert.deepEqual(input, { video: refs.video, music: refs.music });
      return { package: refs.package };
    },
  };

  while (Object.values(states).some((status) => status !== 'SUCCEEDED')) {
    const ready = readyWorkflowNodes(definition, states);
    assert.notEqual(ready.length, 0, 'fixture execution must always make DAG progress');
    executionBatches.push(ready);
    await Promise.all(ready.map(async (nodeId) => {
      const node = definition.nodes.find((candidate) => candidate.node_id === nodeId);
      const input = materializeBindings(node.input_bindings, workflowInput, outputs);
      inputs[nodeId] = input;
      exactTargetTrace.push({ node_id: nodeId, ...node.target });
      outputs[nodeId] = handlers[nodeId](input);
      states[nodeId] = 'SUCCEEDED';
    }));
  }

  const finalOutput = materializeBindings(definition.output_bindings, workflowInput, outputs);
  assert.deepEqual(executionBatches, [['image'], ['music', 'video'], ['aggregate']]);
  assert.deepEqual(inputs.video.image, outputs.image.image);
  assert.deepEqual(inputs.music.cover_image, outputs.image.image);
  assert.deepEqual(inputs.aggregate, { video: outputs.video.video, music: outputs.music.music });
  assert.deepEqual(finalOutput, { package: refs.package, video: refs.video, music: refs.music });
  assert.deepEqual(exactTargetTrace.map(({ node_id, release_id, action_id, action_contract_version }) => ({ node_id, release_id, action_id, action_contract_version })), [
    { node_id: 'image', release_id: 'rel-image-1.4.2', action_id: 'image.generate', action_contract_version: '1.2.0' },
    { node_id: 'music', release_id: 'rel-music-3.1.0', action_id: 'music.compose', action_contract_version: '3.0.1' },
    { node_id: 'video', release_id: 'rel-video-2.3.7', action_id: 'video.from-image', action_contract_version: '2.1.0' },
    { node_id: 'aggregate', release_id: 'rel-aggregate-1.0.5', action_id: 'media.aggregate', action_contract_version: '1.0.0' },
  ]);
});
