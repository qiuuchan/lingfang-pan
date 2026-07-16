export type PreviewHandshakeSession = { sessionId: string; nonce: string; expiresAt: number; consumed: boolean };
export type PreviewHandshakeEvent = { origin: string; source: unknown; data: unknown };
export type PreviewIsolationReport = {
  parent_dom_readable: boolean;
  parent_storage_readable: boolean;
  parent_token_readable: boolean;
  own_storage_readable: boolean;
  own_cookie_readable: boolean;
};

export function validatePreviewHandshake(session: PreviewHandshakeSession, event: PreviewHandshakeEvent, iframeWindow: unknown, now = Date.now()): boolean {
  if (session.consumed || now >= session.expiresAt) return false;
  if (event.origin !== 'null' || event.source !== iframeWindow) return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
  const payload = event.data as Record<string, unknown>;
  if (payload.type !== 'lingfang.preview.handshake.v1' || payload.session_id !== session.sessionId || payload.nonce !== session.nonce) return false;
  return previewIsolationReportSafe(payload.security_report);
}

export function acceptPreviewHandshake(session: PreviewHandshakeSession, event: PreviewHandshakeEvent, iframeWindow: unknown, now = Date.now()): boolean {
  if (!validatePreviewHandshake(session, event, iframeWindow, now)) return false;
  session.consumed = true;
  return true;
}

export function previewIsolationReportSafe(value: unknown): value is PreviewIsolationReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const keys = ['parent_dom_readable', 'parent_storage_readable', 'parent_token_readable', 'own_storage_readable', 'own_cookie_readable'] as const;
  return keys.every((key) => report[key] === false);
}

export const PREVIEW_SAFE_CAPABILITIES = new Set(['ui.view', 'artifact.read.preview']);
export function previewCapabilityAllowed(capability: string): boolean { return PREVIEW_SAFE_CAPABILITIES.has(capability); }
