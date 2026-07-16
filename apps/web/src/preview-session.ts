import { WebPreviewSession, type WebPreviewSession as PreviewSession } from '@lingfang/contract';
import { requestJson, type FetchImplementation } from './api';

const ConsumeResponse = {
  parse(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('预览握手响应无效');
    const result = value as Record<string, unknown>;
    if (result.ok !== true || typeof result.session_id !== 'string') throw new Error('预览握手响应无效');
    return { ok: true as const, session_id: result.session_id };
  },
};

export function createClientPreviewSession(packageId: string, fetchImplementation?: FetchImplementation): Promise<PreviewSession> {
  return requestJson(`/api/web/plugin-preview/${encodeURIComponent(packageId)}/sessions`, WebPreviewSession, { method: 'POST' }, fetchImplementation);
}

export function consumeClientPreviewSession(sessionId: string, nonce: string, fetchImplementation?: FetchImplementation) {
  return requestJson(`/api/web/plugin-preview/sessions/${encodeURIComponent(sessionId)}/consume`, ConsumeResponse, {
    method: 'POST',
    body: JSON.stringify({ nonce }),
  }, fetchImplementation);
}
