import { describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '@/lib/types';
import {
  applyWorkflowUpgradeSuggestions,
  assessWorkflowExecutionSupport,
  decodeWorkflowDefinition,
  initialWorkflowInput,
  setWorkflowInputValue,
  validateWorkflowInput,
} from './workflow-runtime';

const digest = 'a'.repeat(64);
const objectSchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

function node(nodeId: string, dependsOn: string[] = []) {
  return {
    node_id: nodeId,
    declared_version_range: '^1.0.0',
    target: {
      package_id: `package.${nodeId}`,
      release_id: `release.${nodeId}`,
      sha256: digest,
      action_id: 'default',
      action_contract_version: '1.0.0',
      action_surface_sha256: digest,
    },
    depends_on: dependsOn,
    input_bindings: [],
    retry_limit: 0 as const,
  };
}

function plugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return { id: 'workflow', name: 'Workflow', version: '1.0.0', entry: 'workflow.json', runtime_type: 'workflow', ...overrides };
}

describe('workflow definition boundary', () => {
  it('通过共享 engine 解码并产生稳定 DAG 阶段', () => {
    const definition = {
      definition_version: '1',
      input_schema: objectSchema,
      output_schema: objectSchema,
      nodes: [node('image'), node('music', ['image']), node('video', ['image'])],
      output_bindings: [],
    };
    const result = decodeWorkflowDefinition([{ path: 'workflow.json', content: JSON.stringify(definition) }], 'workflow.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.levels).toEqual([['image'], ['music', 'video']]);
  });

  it('缺失、非法 JSON 与循环都返回可定位诊断', () => {
    expect(decodeWorkflowDefinition([], 'workflow.json')).toMatchObject({ ok: false, diagnostics: [{ path: 'workflow.json' }] });
    expect(decodeWorkflowDefinition([{ path: 'workflow.json', content: '{' }], 'workflow.json')).toMatchObject({ ok: false, diagnostics: [{ code: 'workflow_invalid' }] });
    const cyclic = { definition_version: '1', input_schema: objectSchema, output_schema: objectSchema, nodes: [node('a', ['b']), node('b', ['a'])], output_bindings: [] };
    expect(decodeWorkflowDefinition([{ path: 'workflow.json', content: JSON.stringify(cyclic) }], 'workflow.json')).toMatchObject({ ok: false, diagnostics: [{ code: 'workflow_cycle_detected' }] });
  });

  it('采纳建议只替换精确 target，保留 declared range，并提升草稿版本', () => {
    const currentNode = node('image');
    const definition = { definition_version: '1', input_schema: objectSchema, output_schema: objectSchema, nodes: [currentNode], output_bindings: [] };
    const files = [
      { path: 'manifest.json', content: JSON.stringify({ id: 'workflow.demo', name: 'Workflow', version: '1.2.3', runtime_type: 'workflow', entry: 'workflow.json' }) },
      { path: 'workflow.json', content: JSON.stringify(definition) },
      { path: 'preview.png', content: 'AA==', binary: true },
    ];
    const suggestedTarget = { ...currentNode.target, release_id: 'release.image.v2', sha256: 'b'.repeat(64), action_surface_sha256: 'c'.repeat(64) };
    const adopted = applyWorkflowUpgradeSuggestions(files, 'workflow.json', [{ node_id: 'image', declared_version_range: '^1.0.0', current_version: '1.0.0', current_target: currentNode.target, suggested_version: '1.4.0', suggested_target: suggestedTarget, reason: 'compatible' }]);
    const nextDefinition = JSON.parse(adopted.files.find((file) => file.path === 'workflow.json')!.content);
    const nextManifest = JSON.parse(adopted.files.find((file) => file.path === 'manifest.json')!.content);
    expect(nextDefinition.nodes[0].declared_version_range).toBe('^1.0.0');
    expect(nextDefinition.nodes[0].target).toEqual(suggestedTarget);
    expect(nextManifest.version).toBe('1.2.4');
    expect(adopted.files.find((file) => file.path === 'preview.png')).toEqual(files[2]);
  });

  it('拒绝把过期 suggestion 应用到已经变化的精确 target', () => {
    const currentNode = node('image');
    const files = [
      { path: 'manifest.json', content: JSON.stringify({ id: 'workflow.demo', name: 'Workflow', version: '1.0.0', runtime_type: 'workflow', entry: 'workflow.json' }) },
      { path: 'workflow.json', content: JSON.stringify({ definition_version: '1', input_schema: objectSchema, output_schema: objectSchema, nodes: [currentNode], output_bindings: [] }) },
    ];
    expect(() => applyWorkflowUpgradeSuggestions(files, 'workflow.json', [{ node_id: 'image', declared_version_range: '^1.0.0', current_version: '0.9.0', current_target: { ...currentNode.target, release_id: 'stale' }, suggested_version: '1.1.0', suggested_target: currentNode.target, reason: 'stale' }])).toThrow('已过期');
  });
});

describe('workflow input schema', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string' as const, minLength: 2 },
      count: { type: 'integer' as const, minimum: 1, maximum: 4 },
      enabled: { type: 'boolean' as const },
      tags: { type: 'array' as const, items: { type: 'string' as const }, minItems: 1 },
    },
    required: ['prompt', 'count'],
    additionalProperties: false as const,
  };

  it('只为必填字段建立初值，并能不可变更新/删除可选字段', () => {
    const initial = initialWorkflowInput(schema);
    expect(initial).toEqual({ prompt: '', count: 1 });
    const withEnabled = setWorkflowInputValue(initial, ['enabled'], true);
    expect(withEnabled).toEqual({ prompt: '', count: 1, enabled: true });
    expect(setWorkflowInputValue(withEnabled, ['enabled'], undefined)).toEqual({ prompt: '', count: 1 });
  });

  it('校验 required、边界、数组和未声明字段', () => {
    const issues = validateWorkflowInput(schema, { prompt: 'x', count: 9, tags: [], extra: true });
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['/prompt', '/count', '/tags', '/extra']));
    expect(validateWorkflowInput(schema, { prompt: 'image', count: 2 })).toEqual([]);
  });
});

describe('workflow execution support', () => {
  it('精确安装项在桌面 Action adapter 可用时允许本地运行', () => {
    const installed = plugin({ installationId: 'i1', packageId: 'p1', releaseId: 'r1', releaseSha256: digest });
    const support = assessWorkflowExecutionSupport(installed, { desktopShell: true });
    expect(support.desktop).toEqual({ available: true, reason: '本地手动运行可用' });
    expect(support.cloud).toEqual({ available: true, reason: '可通过 Cloud 执行；选择后将检查全部节点部署、配额与团队策略' });
    expect(assessWorkflowExecutionSupport(installed, { desktopShell: true, desktopActionAdapterAvailable: false }).desktop).toMatchObject({ available: false });
    expect(assessWorkflowExecutionSupport(installed, { desktopShell: true, desktopActionAdapterAvailable: true }).desktop).toEqual({ available: true, reason: '本地手动运行可用' });
  });

  it('浏览器和非精确安装项即使未来启用 adapter 也不能启动', () => {
    expect(assessWorkflowExecutionSupport(plugin(), { desktopShell: false, desktopActionAdapterAvailable: true }).desktop.reason).toContain('桌面应用');
    expect(assessWorkflowExecutionSupport(plugin(), { desktopShell: true, desktopActionAdapterAvailable: true }).desktop.reason).toContain('精确发行版');
    expect(assessWorkflowExecutionSupport(plugin(), { desktopShell: true, desktopActionAdapterAvailable: true }).cloud).toMatchObject({ available: false });
  });

  it('待激活工作流同时禁止本地和 Cloud 精确执行', () => {
    const pending = plugin({ installationId: 'i1', packageId: 'p1', releaseId: 'r1', releaseSha256: digest, pendingActivation: { releaseId: 'r2' } });
    const support = assessWorkflowExecutionSupport(pending, { desktopShell: true });
    expect(support.desktop).toMatchObject({ available: false });
    expect(support.cloud).toMatchObject({ available: false });
  });
});
