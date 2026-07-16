import { api, apiDownload } from './api';

export type SharedNamespaceOwnerKind = 'PACKAGE' | 'WORKFLOW';

/** Metadata projection used by team-admin.  It intentionally has no values. */
export interface SharedNamespaceAdmin {
  namespace_id: string;
  team_id: string;
  owner_kind: SharedNamespaceOwnerKind;
  owner_id: string;
  name: string;
  generation: number;
  deleted_at: string | null;
  active_schema_version: number;
  next_value_revision: string;
  next_change_cursor: string;
  used_bytes: number;
  quota_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface SharedNamespaceListResponse {
  namespaces: SharedNamespaceAdmin[];
}

export interface SharedNamespaceLifecycleResult {
  namespace_id: string;
  namespace_generation: number;
  active_schema_version: number;
  next_value_revision: string;
  next_change_cursor: string;
  used_bytes: number;
  deleted_at: string | null;
}

export interface SharedNamespaceMigrationInput {
  value: unknown;
  source_schema_version: number;
  target_schema_version: number;
  expected_revision: string;
}

const root = '/api/teams/current/plugin-shared/namespaces';

export function listSharedNamespaces(): Promise<SharedNamespaceListResponse> {
  return api<SharedNamespaceListResponse>(root);
}

export function exportSharedNamespace(namespaceId: string): Promise<Blob> {
  return apiDownload(`${root}/${encodeURIComponent(namespaceId)}/export`);
}

export function deleteSharedNamespace(namespaceId: string): Promise<SharedNamespaceLifecycleResult> {
  return api<SharedNamespaceLifecycleResult>(`${root}/${encodeURIComponent(namespaceId)}`, { method: 'DELETE' });
}

export function reactivateSharedNamespace(namespaceId: string, activeSchemaVersion: number): Promise<SharedNamespaceLifecycleResult> {
  return api<SharedNamespaceLifecycleResult>(`${root}/${encodeURIComponent(namespaceId)}/reactivate`, {
    method: 'PUT',
    body: { active_schema_version: activeSchemaVersion },
  });
}

export function migrateSharedNamespaceValue(namespaceId: string, key: string, input: SharedNamespaceMigrationInput): Promise<unknown> {
  return api(`${root}/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}/migrate`, {
    method: 'PUT',
    body: input,
  });
}
