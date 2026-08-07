import {
  ArtifactRefV1,
  WorkflowDefinitionV1,
  type PortableJsonSchemaNode,
  type WorkflowDefinitionV1 as WorkflowDefinition,
  type WorkflowUpgradeSuggestion,
} from '@lingfang/contract';
import { buildWorkflowPlan, type WorkflowDiagnostic } from '@lingfang/workflow-engine';
import type { DraftFile, LoadedPlugin } from '@/lib/types';

export type WorkflowDefinitionResult =
  | {
      ok: true;
      definition: WorkflowDefinition;
      levels: string[][];
      maxParallelism: number;
      diagnostics: [];
    }
  | {
      ok: false;
      diagnostics: WorkflowDiagnostic[];
    };

export type WorkflowInputIssue = { path: string; message: string };

export type WorkflowExecutionSupport = {
  desktop: { available: boolean; reason: string };
  cloud: { available: boolean; reason: string };
};

function definitionFile(files: DraftFile[] | undefined, entry: string): DraftFile | undefined {
  return files?.find((file) => file.path === entry);
}

/**
 * workflow.json is an untrusted package boundary. Parse it once through the
 * shared workflow engine so every UI consumer receives the same normalized
 * definition, cycle diagnostics and topological levels.
 */
export function decodeWorkflowDefinition(
  files: DraftFile[] | undefined,
  entry: string
): WorkflowDefinitionResult {
  const file = definitionFile(files, entry);
  if (!file) {
    return {
      ok: false,
      diagnostics: [{ code: 'workflow_invalid', path: entry, message: '安装包缺少工作流入口文件' }],
    };
  }
  let input: unknown;
  try {
    input = JSON.parse(file.content);
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    return {
      ok: false,
      diagnostics: [
        { code: 'workflow_invalid', path: entry, message: `工作流 JSON 无法解析：${detail}` },
      ],
    };
  }
  const result = buildWorkflowPlan(input);
  if (!result.plan) return { ok: false, diagnostics: result.diagnostics };
  return {
    ok: true,
    definition: result.plan.definition,
    levels: result.plan.ready_sets,
    maxParallelism: result.plan.max_parallelism,
    diagnostics: [],
  };
}

function sameActionTarget(
  left: WorkflowUpgradeSuggestion['current_target'],
  right: WorkflowUpgradeSuggestion['current_target']
): boolean {
  return (
    left.package_id === right.package_id &&
    left.release_id === right.release_id &&
    left.sha256 === right.sha256 &&
    left.action_id === right.action_id &&
    left.action_contract_version === right.action_contract_version &&
    left.action_surface_sha256 === right.action_surface_sha256
  );
}

export function nextWorkflowDraftVersion(version: string): string {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version
    );
  if (!match) throw new Error('当前工作流版本不是严格 SemVer');
  if (match[4]) return `${match[1]}.${match[2]}.${match[3]}`;
  return `${match[1]}.${match[2]}.${BigInt(match[3]!) + 1n}`;
}

/**
 * Applies advisory targets to an editable copy only. The current exact target
 * and declared range must still match the suggestion, preventing a stale
 * response from overwriting a newer local draft.
 */
export function applyWorkflowUpgradeSuggestions(
  files: DraftFile[],
  entry: string,
  suggestions: WorkflowUpgradeSuggestion[]
): { files: DraftFile[]; version: string; appliedNodeIds: string[] } {
  if (!suggestions.length) throw new Error('当前没有可采纳的工作流升级建议');
  const decoded = decodeWorkflowDefinition(files, entry);
  if (!decoded.ok) throw new Error(decoded.diagnostics[0]?.message || '工作流定义无效');
  const suggestionByNode = new Map(
    suggestions.map((suggestion) => [suggestion.node_id, suggestion])
  );
  if (suggestionByNode.size !== suggestions.length) throw new Error('升级建议包含重复节点');
  const appliedNodeIds: string[] = [];
  const definition = {
    ...decoded.definition,
    nodes: decoded.definition.nodes.map((node) => {
      const suggestion = suggestionByNode.get(node.node_id);
      if (!suggestion) return node;
      if (
        node.declared_version_range !== suggestion.declared_version_range ||
        !sameActionTarget(node.target, suggestion.current_target)
      )
        throw new Error(`节点 ${node.node_id} 的升级建议已过期，请刷新后重试`);
      appliedNodeIds.push(node.node_id);
      return { ...node, target: suggestion.suggested_target };
    }),
  };
  if (appliedNodeIds.length !== suggestions.length)
    throw new Error('升级建议包含当前工作流中不存在的节点');
  const validated = WorkflowDefinitionV1.parse(definition);
  const manifestFile = files.find((file) => file.path === 'manifest.json' && !file.binary);
  if (!manifestFile) throw new Error('工作流草稿缺少 manifest.json');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestFile.content) as Record<string, unknown>;
  } catch {
    throw new Error('工作流 manifest.json 无法解析');
  }
  if (manifest.runtime_type !== 'workflow')
    throw new Error('只有 workflow 插件可以采纳工作流升级建议');
  const version = nextWorkflowDraftVersion(String(manifest.version || ''));
  const nextFiles = files.map((file) => {
    if (file.path === entry)
      return { ...file, binary: false, content: `${JSON.stringify(validated, null, 2)}\n` };
    if (file.path === 'manifest.json')
      return {
        ...file,
        binary: false,
        content: `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
      };
    return file;
  });
  const verified = decodeWorkflowDefinition(nextFiles, entry);
  if (!verified.ok) throw new Error(verified.diagnostics[0]?.message || '升级后的工作流未通过校验');
  return { files: nextFiles, version, appliedNodeIds: appliedNodeIds.sort() };
}

function schemaTypes(schema: PortableJsonSchemaNode): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  return schema.type ? [schema.type] : [];
}

function primaryType(schema: PortableJsonSchemaNode): string | undefined {
  return schemaTypes(schema).find((item) => item !== 'null');
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function initialWorkflowInput(schema: PortableJsonSchemaNode): unknown {
  if ('const' in schema) return structuredClone(schema.const);
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  if (schemaTypes(schema).includes('null')) return null;
  switch (primaryType(schema)) {
    case 'object': {
      const required = new Set(schema.required ?? []);
      return Object.fromEntries(
        Object.entries(schema.properties ?? {})
          .filter(([name]) => required.has(name))
          .map(([name, child]) => [name, initialWorkflowInput(child)])
      );
    }
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return schema.minimum ?? schema.exclusiveMinimum ?? 0;
    case 'string':
      return '';
    default:
      return undefined;
  }
}

function addIssue(issues: WorkflowInputIssue[], path: string, message: string): void {
  issues.push({ path: path || '/', message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateNode(
  schema: PortableJsonSchemaNode,
  value: unknown,
  path: string,
  issues: WorkflowInputIssue[]
): void {
  if (schema.$ref === 'lingfang://schemas/artifact-ref/v1') {
    const parsed = ArtifactRefV1.safeParse(value);
    if (!parsed.success) addIssue(issues, path, '必须是有效的 ArtifactRef');
    return;
  }
  if ('const' in schema && !sameJsonValue(value, schema.const))
    addIssue(issues, path, '值必须与工作流常量一致');
  if (schema.enum && !schema.enum.some((item) => sameJsonValue(item, value)))
    addIssue(issues, path, '请选择允许的枚举值');
  if (value === null) {
    if (!schemaTypes(schema).includes('null')) addIssue(issues, path, '此字段不能为空');
    return;
  }
  const type = primaryType(schema);
  if (type === 'object') {
    if (!isRecord(value)) {
      addIssue(issues, path, '必须是对象');
      return;
    }
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!(name in value)) addIssue(issues, `${path}/${name}`, '此字段为必填项');
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (!childSchema) addIssue(issues, `${path}/${name}`, '包含未声明的字段');
      else validateNode(childSchema, child, `${path}/${name}`, issues);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      addIssue(issues, path, '必须是数组');
      return;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      addIssue(issues, path, `至少需要 ${schema.minItems} 项`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      addIssue(issues, path, `最多允许 ${schema.maxItems} 项`);
    value.forEach((item, index) =>
      validateNode(schema.items ?? {}, item, `${path}/${index}`, issues)
    );
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      addIssue(issues, path, '必须是文本');
      return;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      addIssue(issues, path, `至少需要 ${schema.minLength} 个字符`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      addIssue(issues, path, `最多允许 ${schema.maxLength} 个字符`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value)))
      addIssue(issues, path, '必须是有效的日期时间');
    if (
      schema.format === 'uuid' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    )
      addIssue(issues, path, '必须是有效的 UUID');
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') addIssue(issues, path, '必须是布尔值');
    return;
  }
  if (type === 'number' || type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isInteger(value))
    ) {
      addIssue(issues, path, type === 'integer' ? '必须是整数' : '必须是数字');
      return;
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      addIssue(issues, path, `不能小于 ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      addIssue(issues, path, `不能大于 ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
      addIssue(issues, path, `必须大于 ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
      addIssue(issues, path, `必须小于 ${schema.exclusiveMaximum}`);
    if (
      typeof schema.multipleOf === 'number' &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9
    )
      addIssue(issues, path, `必须是 ${schema.multipleOf} 的倍数`);
    return;
  }
  if (type === 'null' && value !== null) addIssue(issues, path, '值必须为空');
}

export function validateWorkflowInput(
  schema: PortableJsonSchemaNode,
  value: unknown
): WorkflowInputIssue[] {
  const issues: WorkflowInputIssue[] = [];
  validateNode(schema, value, '', issues);
  return issues;
}

export function setWorkflowInputValue(root: unknown, path: string[], value: unknown): unknown {
  if (!path.length) return value;
  const result = isRecord(root) ? structuredClone(root) : {};
  let cursor = result;
  path.forEach((part, index) => {
    if (index === path.length - 1) {
      if (value === undefined) delete cursor[part];
      else cursor[part] = value;
      return;
    }
    const current = cursor[part];
    cursor[part] = isRecord(current) ? current : {};
    cursor = cursor[part] as Record<string, unknown>;
  });
  return result;
}

/** Native executor owns exact release resolution, claim leases and handlers. */
export const DESKTOP_WORKFLOW_ACTION_ADAPTER_AVAILABLE = true;

export function assessWorkflowExecutionSupport(
  plugin: LoadedPlugin,
  options: { desktopShell: boolean; desktopActionAdapterAvailable?: boolean } = {
    desktopShell: false,
  }
): WorkflowExecutionSupport {
  const adapterAvailable =
    options.desktopActionAdapterAvailable ?? DESKTOP_WORKFLOW_ACTION_ADAPTER_AVAILABLE;
  let desktopReason = '本地手动运行可用';
  if (!options.desktopShell) desktopReason = '需要在灵坊桌面应用中运行';
  else if (
    !plugin.installationId ||
    !plugin.packageId ||
    !plugin.releaseId ||
    !plugin.releaseSha256
  )
    desktopReason = '仅已安装的精确发行版可以创建桌面运行';
  else if (plugin.pendingActivation) desktopReason = '待更新版本尚未激活，不能用于精确执行';
  else if (!adapterAvailable) desktopReason = '当前桌面版本不包含本地 Action 执行适配器';
  let cloudReason = '可通过 Cloud 执行；选择后将检查全部节点部署、配额与团队策略';
  if (!plugin.packageId || !plugin.releaseId || !plugin.releaseSha256)
    cloudReason = '只有精确已发布版本可以创建 Cloud 运行';
  else if (plugin.pendingActivation) cloudReason = '待更新版本尚未激活，不能用于精确 Cloud 执行';
  return {
    desktop: { available: desktopReason === '本地手动运行可用', reason: desktopReason },
    cloud: { available: cloudReason.startsWith('可通过 Cloud'), reason: cloudReason },
  };
}
