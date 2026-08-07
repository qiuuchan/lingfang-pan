import {
  ActionErrorCode,
  ActionInvocationSummary,
  ActionTarget,
  PluginActionSurfaceV1,
  PluginManifest,
  satisfiesActionVersionRange,
  type ActionInvocationSummary as ActionInvocationSummaryType,
  type ActionTarget as ActionTargetType,
  type LocalPluginInstallation,
  type PluginActionDependency,
  type PluginActionSurfaceV1 as PluginActionSurfaceV1Type,
} from '@lingfang/contract';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api, apiBase, errorMessage, getAuthToken, tauriInvoke, type ApiError } from '@/lib/api';
import { listInstallations } from '@/lib/plugin-registry';
import type { LoadedPlugin } from '@/lib/types';
import { executeClientActionAdapter } from '@/lib/plugin-action-client-adapter';
import {
  cancelWorkflowRun,
  createDesktopWorkflowSession,
  driveDesktopWorkflowRun,
  getWorkflowRun,
  preflightWorkflowRun,
  revokeDesktopWorkflowSession,
  startWorkflowRun,
  workflowDeadline,
  workflowIdempotencyKey,
} from '@/lib/workflow-client';
import type { WorkflowJsonValue } from '@lingfang/contract';

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT']);
const ACTION_POLL_INTERVAL_MS = 200;

type ActionCallArgs = Record<string, unknown> & {
  dependency_id?: unknown;
  input?: unknown;
  idempotency_key?: unknown;
};

type ActionSurface = PluginActionSurfaceV1Type & { action_surface_sha256: string };
type ActionListResponse = {
  release_id: string;
  package_id: string;
  sha256: string;
  actions: unknown[];
};
type ClientActionHandlerResponse = { source: string; export_name: string; manifest: unknown };
type ActionInvocationContext = { parentInvocationId?: string };

export class DesktopPluginActionError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    code: string,
    message: string,
    options: { status?: number; requestId?: string; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'PluginActionError';
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export type PluginActionHostDependencies = {
  api: typeof api;
  tauriInvoke: typeof tauriInvoke;
  listInstallations: typeof listInstallations;
  uuid: () => string;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  sha256: (value: string) => Promise<string>;
  executeClientAction: typeof executeClientActionAdapter;
};

const defaultDependencies: PluginActionHostDependencies = {
  api,
  tauriInvoke,
  listInstallations,
  uuid: () => crypto.randomUUID(),
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  sha256: async (value) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
  },
  executeClientAction: executeClientActionAdapter,
};

const logicalCallRoots = new WeakMap<object, string>();
let nativeBridgeListener: Promise<void> | null = null;

type NativeActionBridgePayload = {
  request_id: string;
  parent_invocation_id: string;
  caller: LoadedPlugin;
  args: ActionCallArgs;
};

export function ensureNativeActionBridgeListener(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (nativeBridgeListener) return nativeBridgeListener;
  nativeBridgeListener = listen<NativeActionBridgePayload>('plugin-action-bridge-call', (event) => {
    const payload = event.payload;
    void (async () => {
      try {
        if (
          !payload ||
          typeof payload.request_id !== 'string' ||
          typeof payload.parent_invocation_id !== 'string' ||
          !payload.caller
        )
          throw actionError('action_runtime_unavailable', 'Native Action bridge payload 无效');
        const result = await invokeInstalledPluginAction(
          payload.caller,
          payload.args,
          {},
          { parentInvocationId: payload.parent_invocation_id }
        );
        await tauriInvoke('respond_plugin_action_bridge', {
          requestId: payload.request_id,
          result,
        });
      } catch (caught) {
        const error = stableError(caught);
        await tauriInvoke('respond_plugin_action_bridge', {
          requestId: payload?.request_id ?? '',
          error: {
            name: error.name,
            message: error.message,
            code: error.code,
            status: error.status,
            requestId: error.requestId,
          },
        }).catch(() => undefined);
      }
    })();
  })
    .then(() => undefined)
    .catch((error) => {
      nativeBridgeListener = null;
      throw error;
    });
  return nativeBridgeListener;
}

function actionError(code: string, message: string, cause?: unknown): DesktopPluginActionError {
  const source = cause && typeof cause === 'object' ? (cause as ApiError) : undefined;
  return new DesktopPluginActionError(code, message, {
    status: source?.status,
    requestId: source?.requestId,
    cause,
  });
}

function stableError(
  error: unknown,
  fallback = 'action_execution_failed'
): DesktopPluginActionError {
  if (error instanceof DesktopPluginActionError) return error;
  const source = error && typeof error === 'object' ? (error as ApiError) : undefined;
  const stringValue = typeof error === 'string' ? error : source?.message;
  const prefixedCode = stringValue?.split(':', 1)[0];
  const code = ActionErrorCode.safeParse(source?.code).success
    ? String(source?.code)
    : ActionErrorCode.safeParse(prefixedCode).success
      ? String(prefixedCode)
      : fallback;
  return actionError(code, errorMessage(error, '插件 Action 调用失败'), error);
}

function manifestFromPlugin(plugin: LoadedPlugin) {
  let source = plugin.manifest;
  if (!source) {
    const manifestFile = plugin.files?.find((file) => file.path === 'manifest.json');
    if (manifestFile) {
      try {
        source = JSON.parse(manifestFile.content);
      } catch {
        /* handled by schema error below */
      }
    }
  }
  const parsed = PluginManifest.safeParse(source);
  if (!parsed.success)
    throw actionError('action_dependency_denied', '当前插件 manifest 无法用于跨插件调用');
  return parsed.data;
}

function exactCaller(plugin: LoadedPlugin, installations: LocalPluginInstallation[]) {
  if (!plugin.installationId || !plugin.packageId || !plugin.releaseId || !plugin.releaseSha256) {
    throw actionError('action_dependency_denied', '只有已安装的精确发行版可以调用插件依赖');
  }
  const installation = installations.find((item) => item.installationId === plugin.installationId);
  if (
    !installation ||
    installation.packageId !== plugin.packageId ||
    installation.activeRelease.releaseId !== plugin.releaseId ||
    installation.activeRelease.sha256 !== plugin.releaseSha256
  ) {
    throw actionError('action_dependency_denied', '调用方与本机 active release 不一致');
  }
  return {
    package_id: plugin.packageId,
    release_id: plugin.releaseId,
    sha256: plugin.releaseSha256,
  };
}

function resolveInstalledDependency(
  dependency: PluginActionDependency,
  installations: LocalPluginInstallation[]
): LocalPluginInstallation {
  const target = installations.find((item) => item.packageId === dependency.package_id);
  if (!target)
    throw actionError(
      'action_runtime_unavailable',
      `依赖插件尚未安装：${dependency.dependency_id}`
    );
  if (target.activeRelease.dependencyStatus !== 'ready') {
    throw actionError(
      'action_runtime_unavailable',
      `依赖插件运行环境尚未就绪：${dependency.dependency_id}`
    );
  }
  if (
    !satisfiesActionVersionRange(target.activeRelease.version, dependency.release_version_range)
  ) {
    throw actionError(
      'action_contract_mismatch',
      `依赖插件版本不满足 ${dependency.release_version_range}`
    );
  }
  return target;
}

function parseActionSurface(value: unknown): ActionSurface | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const surface = PluginActionSurfaceV1.safeParse({
    schema_version: raw.schema_version,
    action_id: raw.action_id,
    action_contract_version: raw.action_contract_version,
    input_schema: raw.input_schema,
    output_schema: raw.output_schema,
    execution_semantics: raw.execution_semantics,
    timeout_seconds: raw.timeout_seconds,
    cloud_capable: raw.cloud_capable,
    previewable: raw.previewable,
    execution: raw.execution,
  });
  const digest = typeof raw.action_surface_sha256 === 'string' ? raw.action_surface_sha256 : '';
  return surface.success && /^[a-f0-9]{64}$/.test(digest)
    ? { ...surface.data, action_surface_sha256: digest }
    : null;
}

async function resolveExactTarget(
  dependency: PluginActionDependency,
  installation: LocalPluginInstallation,
  deps: PluginActionHostDependencies
): Promise<{ target: ActionTargetType; action: ActionSurface }> {
  const response = await deps.api<ActionListResponse>(
    `/api/plugin-releases/${encodeURIComponent(installation.activeRelease.releaseId)}/actions`
  );
  if (
    response.package_id !== installation.packageId ||
    response.release_id !== installation.activeRelease.releaseId ||
    response.sha256 !== installation.activeRelease.sha256
  ) {
    throw actionError(
      'action_contract_mismatch',
      '依赖插件的服务端身份与本机 active release 不一致'
    );
  }
  const action = response.actions
    .map(parseActionSurface)
    .find((candidate) => candidate?.action_id === dependency.action_id);
  if (!action) throw actionError('action_not_found', `依赖未导出 Action：${dependency.action_id}`);
  if (
    !satisfiesActionVersionRange(
      action.action_contract_version,
      dependency.action_contract_version_range
    )
  ) {
    throw actionError(
      'action_contract_mismatch',
      `Action contract 不满足 ${dependency.action_contract_version_range}`
    );
  }
  return {
    target: ActionTarget.parse({
      package_id: response.package_id,
      release_id: response.release_id,
      sha256: response.sha256,
      action_id: action.action_id,
      action_contract_version: action.action_contract_version,
      action_surface_sha256: action.action_surface_sha256,
    }),
    action,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function effectKey(
  plugin: LoadedPlugin,
  caller: { package_id: string; release_id: string; sha256: string },
  dependencyId: string,
  target: ActionTargetType,
  hint: string,
  deps: PluginActionHostDependencies
) {
  let root = logicalCallRoots.get(plugin);
  if (!root) {
    root = deps.uuid();
    logicalCallRoots.set(plugin, root);
  }
  return deps.sha256(canonicalJson({ root, caller, dependency_id: dependencyId, target, hint }));
}

async function pollTerminal(
  id: string,
  deadlineAt: number,
  deps: PluginActionHostDependencies
): Promise<ActionInvocationSummaryType> {
  while (deps.now() <= deadlineAt + 5_000) {
    const invocation = ActionInvocationSummary.parse(
      await deps.api(`/api/plugin-actions/invocations/${encodeURIComponent(id)}`)
    );
    if (TERMINAL_STATUSES.has(invocation.status)) return invocation;
    await deps.sleep(ACTION_POLL_INTERVAL_MS);
  }
  throw actionError('action_timeout', '等待 Action invocation 终态超时');
}

function terminalOutput(invocation: ActionInvocationSummaryType): Record<string, unknown> {
  if (invocation.status === 'SUCCEEDED' && invocation.output) return invocation.output;
  const fallback =
    invocation.status === 'CANCELED'
      ? 'action_cancelled'
      : invocation.status === 'TIMED_OUT'
        ? 'action_timeout'
        : 'action_execution_failed';
  throw actionError(
    ActionErrorCode.safeParse(invocation.error_code).success ? invocation.error_code : fallback,
    invocation.error_message || '插件 Action 调用失败'
  );
}

async function invokeArtifactCapability(
  invocationId: string,
  kind: string,
  args: unknown,
  deps: PluginActionHostDependencies
): Promise<unknown> {
  const input =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const suffix =
    kind === 'artifacts.create'
      ? ''
      : kind === 'artifacts.materialize'
        ? '/materialize'
        : kind === 'artifacts.import'
          ? '/import'
          : null;
  if (suffix === null)
    throw actionError('action_dependency_denied', `Client Action 不允许调用能力：${kind}`);
  const result = await deps.api<Record<string, unknown>>(
    `/api/plugin-actions/invocations/${encodeURIComponent(invocationId)}/artifacts${suffix}`,
    { method: 'POST', body: input }
  );
  if (kind === 'artifacts.materialize')
    return {
      dataBase64: result.data_base64,
      mediaType: result.media_type,
      sizeBytes: result.size_bytes,
      sha256: result.sha256,
    };
  return result;
}

async function executeWorkflowAction(
  target: ActionTargetType,
  input: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  if (!isTauri()) throw actionError('action_runtime_unavailable', '工作流实例只能在桌面应用中运行');
  const deadline = Date.now() + timeoutMs;
  await createDesktopWorkflowSession();
  try {
    const request = {
      workflow_release_id: target.release_id,
      sha256: target.sha256,
      execution_target: 'DESKTOP' as const,
      execution_scope: 'PRODUCTION' as const,
      input: input as Record<string, WorkflowJsonValue>,
      deadline_at: new Date(deadline).toISOString(),
    };
    const preflight = await preflightWorkflowRun(request);
    if (!preflight.eligible)
      throw actionError(
        'action_runtime_unavailable',
        preflight.diagnostics.find((item) => item.severity === 'ERROR')?.message ||
          '工作流实例预检失败'
      );
    let run = await startWorkflowRun({ ...request, idempotency_key: workflowIdempotencyKey() });
    while (!TERMINAL_STATUSES.has(run.status)) {
      if (Date.now() >= deadline) {
        await cancelWorkflowRun(run.id).catch(() => undefined);
        throw actionError('action_timeout', '工作流实例执行超时');
      }
      await driveDesktopWorkflowRun(run.id, run.plan.max_parallelism);
      await new Promise((resolve) => setTimeout(resolve, 200));
      run = await getWorkflowRun(run.id);
    }
    if (run.status !== 'SUCCEEDED')
      throw actionError('action_execution_failed', run.error?.message || '工作流实例执行失败');
    if (!run.output || typeof run.output !== 'object' || Array.isArray(run.output))
      throw actionError('action_output_invalid', '工作流实例输出必须是 JSON 对象');
    return run.output as Record<string, unknown>;
  } finally {
    await revokeDesktopWorkflowSession().catch(() => undefined);
  }
}

export async function invokeInstalledPluginAction(
  plugin: LoadedPlugin,
  args: ActionCallArgs | undefined,
  overrides: Partial<PluginActionHostDependencies> = {},
  context: ActionInvocationContext = {}
): Promise<Record<string, unknown>> {
  const deps = { ...defaultDependencies, ...overrides };
  const dependencyId = typeof args?.dependency_id === 'string' ? args.dependency_id.trim() : '';
  const input = args?.input;
  const hint = args?.idempotency_key;
  if (!dependencyId)
    throw actionError('action_dependency_denied', 'actions.call 缺少 dependency_id');
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw actionError('action_input_invalid', 'Action input 必须是 JSON 对象');
  if (hint !== undefined && (typeof hint !== 'string' || !hint.trim() || hint.length > 256)) {
    throw actionError('action_idempotency_conflict', 'idempotencyKey 必须是 1 到 256 个字符');
  }

  const manifest = manifestFromPlugin(plugin);
  const dependency = manifest.action_dependencies.find(
    (candidate) => candidate.dependency_id === dependencyId
  );
  if (!dependency)
    throw actionError('action_dependency_denied', `插件未声明 Action 依赖：${dependencyId}`);

  const installations = await deps.listInstallations();
  const caller = exactCaller(plugin, installations);
  const targetInstallation = resolveInstalledDependency(dependency, installations);
  const resolved = await resolveExactTarget(dependency, targetInstallation, deps);
  if (hint !== undefined && resolved.action.execution_semantics !== 'idempotent') {
    throw actionError('action_idempotency_conflict', 'idempotencyKey 仅可用于 idempotent Action');
  }

  const deadlineAt = deps.now() + resolved.action.timeout_seconds * 1_000;
  const requestIdempotencyKey = deps.uuid();
  const invocation = ActionInvocationSummary.parse(
    await deps.api('/api/plugin-actions/invocations', {
      method: 'POST',
      body: {
        target: resolved.target,
        input,
        request_idempotency_key: requestIdempotencyKey,
        ...(typeof hint === 'string'
          ? {
              effect_idempotency_key: await effectKey(
                plugin,
                caller,
                dependencyId,
                resolved.target,
                hint,
                deps
              ),
            }
          : {}),
        deadline_at: new Date(deadlineAt).toISOString(),
        desktop_caller: { ...caller, dependency_id: dependencyId },
        ...(context.parentInvocationId ? { parent_invocation_id: context.parentInvocationId } : {}),
      },
    })
  );
  if (TERMINAL_STATUSES.has(invocation.status)) return terminalOutput(invocation);
  if (invocation.status === 'RUNNING')
    return terminalOutput(await pollTerminal(invocation.id, deadlineAt, deps));

  await deps.api(`/api/plugin-actions/invocations/${encodeURIComponent(invocation.id)}/claim`, {
    method: 'POST',
  });
  try {
    const output =
      resolved.action.execution.runtime_type === 'client'
        ? await (async () => {
            const handler = await deps.tauriInvoke<ClientActionHandlerResponse>(
              'workflow_executor_read_client_action_handler',
              { target: resolved.target }
            );
            const manifest = PluginManifest.parse(handler.manifest);
            const targetPlugin: LoadedPlugin = {
              id: targetInstallation.installationId,
              installationId: targetInstallation.installationId,
              packageId: targetInstallation.packageId,
              releaseId: targetInstallation.activeRelease.releaseId,
              releaseSha256: targetInstallation.activeRelease.sha256,
              installationOrigin: targetInstallation.origin,
              name: manifest.name,
              description: manifest.description,
              version: manifest.version,
              entry: manifest.entry,
              runtime_type: 'client',
              source: 'installed',
              manifest,
            };
            return deps.executeClientAction({
              invocationId: invocation.id,
              source: handler.source,
              exportName: handler.export_name,
              input: input as Record<string, unknown>,
              timeoutMs: Math.max(1, deadlineAt - deps.now()),
              onCapability: (kind, nestedArgs) =>
                kind === 'actions.call'
                  ? invokeInstalledPluginAction(targetPlugin, nestedArgs as ActionCallArgs, deps, {
                      parentInvocationId: invocation.id,
                    })
                  : invokeArtifactCapability(invocation.id, kind, nestedArgs, deps),
            });
          })()
        : resolved.action.execution.runtime_type === 'nodejs' ||
            resolved.action.execution.runtime_type === 'python'
          ? await (async () => {
              await ensureNativeActionBridgeListener();
              return deps.tauriInvoke<Record<string, unknown>>('workflow_executor_execute_action', {
                target: resolved.target,
                input,
                invocationId: invocation.id,
                apiBase: apiBase(),
                authToken: getAuthToken() ?? '',
              });
            })()
          : resolved.action.execution.runtime_type === 'workflow'
            ? await executeWorkflowAction(
                resolved.target,
                input as Record<string, unknown>,
                Math.max(1, deadlineAt - deps.now())
              )
            : await Promise.reject(
                actionError(
                  'action_runtime_unavailable',
                  `桌面本地 Action 尚不支持 ${resolved.action.execution.runtime_type} runtime`
                )
              );
    await deps.api(
      `/api/plugin-actions/invocations/${encodeURIComponent(invocation.id)}/complete`,
      {
        method: 'POST',
        body: { output },
      }
    );
  } catch (caught) {
    const failure = stableError(caught);
    try {
      await deps.api(`/api/plugin-actions/invocations/${encodeURIComponent(invocation.id)}/fail`, {
        method: 'POST',
        body: { code: failure.code, message: failure.message },
      });
    } catch {
      // A competing terminal transition is authoritative; polling below reads it.
    }
  }
  return terminalOutput(await pollTerminal(invocation.id, deadlineAt, deps));
}
