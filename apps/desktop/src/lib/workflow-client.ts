import { isTauri } from '@tauri-apps/api/core';
import {
  DesktopExecutorSession,
  WorkflowPreflightRequest,
  WorkflowPreflightResponse,
  WorkflowRunCancelResponse,
  WorkflowRunCreateRequest,
  WorkflowRunDetailResponse,
  WorkflowRunListResponse,
  WorkflowUpgradeSuggestionResponse,
  type WorkflowPreflightRequest as WorkflowPreflightRequestType,
  type WorkflowPreflightResponse as WorkflowPreflightResponseType,
  type WorkflowRunCreateRequest as WorkflowRunCreateRequestType,
  type WorkflowRunDetail,
  type WorkflowRunListResponse as WorkflowRunListResponseType,
  type WorkflowUpgradeSuggestionResponse as WorkflowUpgradeSuggestionResponseType,
} from '@lingfang/contract';
import { api, apiBase, getAuthToken, tauriInvoke } from '@/lib/api';
import { ensureNativeActionBridgeListener } from '@/lib/plugin-action-runtime';

function decode<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const path = first?.path.length ? `（${first.path.join('.')}）` : '';
  throw new Error(`${label}响应格式不兼容${path}：${first?.message || '未知字段错误'}`);
}

export function hasDesktopWorkflowBridge(): boolean {
  return isTauri();
}

function nativeConnection(): { apiBase: string; authToken: string } {
  const base = apiBase();
  const token = getAuthToken();
  if (!base) throw new Error('尚未配置后端服务地址');
  if (!token) throw new Error('登录状态已失效，请重新登录');
  if (!isTauri()) throw new Error('需要在灵坊桌面应用中运行');
  return { apiBase: base, authToken: token };
}

export async function createDesktopWorkflowSession() {
  const raw = await tauriInvoke('workflow_executor_create_session', nativeConnection());
  return decode(DesktopExecutorSession, raw, '桌面执行器 session');
}

export async function heartbeatDesktopWorkflowSession() {
  const raw = await tauriInvoke('workflow_executor_heartbeat');
  return decode(DesktopExecutorSession, raw, '桌面执行器 heartbeat');
}

export async function revokeDesktopWorkflowSession(): Promise<void> {
  await tauriInvoke('workflow_executor_revoke');
}

export async function preflightWorkflowRun(request: WorkflowPreflightRequestType): Promise<WorkflowPreflightResponseType> {
  const body = WorkflowPreflightRequest.parse(request);
  const raw = request.execution_target === 'DESKTOP' && isTauri()
    ? await tauriInvoke('workflow_executor_preflight', { request: body })
    : await api('/api/workflows/runs/preflight', { method: 'POST', body });
  return decode(WorkflowPreflightResponse, raw, '工作流预检');
}

export async function startWorkflowRun(request: WorkflowRunCreateRequestType): Promise<WorkflowRunDetail> {
  const body = WorkflowRunCreateRequest.parse(request);
  const raw = body.execution_target === 'DESKTOP'
    ? await tauriInvoke('workflow_executor_start_run', { request: body })
    : await api('/api/workflows/runs', { method: 'POST', body });
  return decode(WorkflowRunDetailResponse, raw, '创建工作流运行').run;
}

type NativeClaim = { attempt: { id: string; node_id: string; lease_expires_at: string } | null };

function decodeNativeClaim(value: unknown): NativeClaim {
  if (!value || typeof value !== 'object' || !('attempt' in value)) throw new Error('领取工作流步骤响应格式不兼容');
  const attempt = (value as { attempt?: unknown }).attempt;
  if (attempt === null) return { attempt: null };
  if (!attempt || typeof attempt !== 'object') throw new Error('领取工作流步骤响应格式不兼容（attempt）');
  const record = attempt as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.node_id !== 'string' || typeof record.lease_expires_at !== 'string') throw new Error('领取工作流步骤响应缺少公开 lease 信息');
  return { attempt: { id: record.id, node_id: record.node_id, lease_expires_at: record.lease_expires_at } };
}

export async function claimDesktopWorkflowAttempt(runId: string): Promise<NativeClaim['attempt']> {
  const raw = await tauriInvoke('workflow_executor_claim', { runId });
  return decodeNativeClaim(raw).attempt;
}

export async function executeDesktopWorkflowAttempt(attemptId: string): Promise<WorkflowRunDetail> {
  await ensureNativeActionBridgeListener();
  const raw = await tauriInvoke('workflow_executor_execute_attempt', { attemptId });
  return decode(WorkflowRunDetailResponse, raw, '执行工作流步骤').run;
}

export async function driveDesktopWorkflowRun(runId: string, maxParallelism: number): Promise<{ claimed: number; failures: string[] }> {
  const claims: NonNullable<NativeClaim['attempt']>[] = [];
  for (let index = 0; index < Math.max(1, Math.min(maxParallelism, 8)); index += 1) {
    const attempt = await claimDesktopWorkflowAttempt(runId);
    if (!attempt) break;
    claims.push(attempt);
  }
  const settled = await Promise.allSettled(claims.map((attempt) => executeDesktopWorkflowAttempt(attempt.id)));
  return {
    claimed: claims.length,
    failures: settled.flatMap((result) => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []),
  };
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  const raw = await api(`/api/workflows/runs/${encodeURIComponent(runId)}`);
  return decode(WorkflowRunDetailResponse, raw, '工作流运行详情').run;
}

export async function cancelWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  const raw = await api(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  return decode(WorkflowRunCancelResponse, raw, '取消工作流运行').run;
}

export async function listWorkflowRuns(params: { cursor?: string; limit?: number } = {}): Promise<WorkflowRunListResponseType> {
  const search = new URLSearchParams();
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit) search.set('limit', String(params.limit));
  const raw = await api(`/api/workflows/runs${search.size ? `?${search}` : ''}`);
  return decode(WorkflowRunListResponse, raw, '工作流运行列表');
}

export async function getWorkflowUpgradeSuggestions(releaseId: string): Promise<WorkflowUpgradeSuggestionResponseType> {
  const raw = await api(`/api/plugin-releases/${encodeURIComponent(releaseId)}/workflow-upgrades`);
  return decode(WorkflowUpgradeSuggestionResponse, raw, '工作流升级建议');
}

export function workflowDeadline(hours = 1): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function workflowIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `desktop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
