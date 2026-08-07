import { api } from '@/lib/api';
import type { TeamPluginPolicyDocumentV1 as PolicyDocument } from '@lingfang/contract';

export type TeamPluginPolicyRevision = {
  id?: string;
  teamId: string;
  revision: number;
  enforcementMode: 'AUDIT' | 'ENFORCE';
  document: PolicyDocument | null;
  documentSha256?: string;
  sourceRevisionId?: string | null;
  changeReason?: string;
  createdAt?: string;
};
export const DEFAULT_PLUGIN_POLICY: PolicyDocument = {
  schema_version: 1,
  enforcement_mode: 'ENFORCE',
  allowed_source_kinds: [
    'LINGFANG_CREATOR',
    'EXTERNAL_TOOL',
    'LOCAL_ARTIFACT',
    'COPIED_INSTALLATION',
    'API',
    'LEGACY_MIGRATION',
    'UNKNOWN',
  ],
  denied_capability_kinds: [],
  rules: [],
};
export const getPluginPolicy = () =>
  api<TeamPluginPolicyRevision>('/api/teams/current/plugin-policy');
export const getPluginPolicyHistory = () =>
  api<{ revisions: TeamPluginPolicyRevision[] }>('/api/teams/current/plugin-policy/history');
export const publishPluginPolicy = (
  expectedRevision: number,
  document: PolicyDocument,
  reason: string
) =>
  api<TeamPluginPolicyRevision>('/api/teams/current/plugin-policy/publish', {
    method: 'POST',
    body: { expected_revision: expectedRevision, document, change_reason: reason },
  });
export const rollbackPluginPolicy = (
  expectedRevision: number,
  sourceRevision: number,
  reason: string
) =>
  api<TeamPluginPolicyRevision>('/api/teams/current/plugin-policy/rollback', {
    method: 'POST',
    body: {
      expected_revision: expectedRevision,
      source_revision: sourceRevision,
      change_reason: reason,
    },
  });
