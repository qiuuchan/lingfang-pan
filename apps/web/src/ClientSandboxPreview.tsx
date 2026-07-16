import type { PublicPluginDetail, WebPreviewSession } from '@lingfang/contract';
import React, { useEffect, useRef, useState } from 'react';
import { prepareWebSession } from './session';
import { consumeClientPreviewSession, createClientPreviewSession } from './preview-session';
import {
  previewCapabilityAllowed,
  validatePreviewHandshake,
  type PreviewHandshakeSession,
  type PreviewIsolationReport,
} from './preview-handshake';

export const PREVIEW_IFRAME_SANDBOX = 'allow-scripts allow-downloads';

export function ClientSandboxPreview({ detail }: { detail: PublicPluginDetail }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const handshakeRef = useRef<PreviewHandshakeSession | null>(null);
  const consumeInFlight = useRef(false);
  const [session, setSession] = useState<WebPreviewSession | null>(null);
  const [status, setStatus] = useState<'LOADING' | 'HANDSHAKE' | 'READY' | 'ERROR'>('LOADING');
  const [error, setError] = useState('');
  const [report, setReport] = useState<PreviewIsolationReport | null>(null);

  useEffect(() => {
    let active = true;
    setStatus('LOADING'); setError(''); setSession(null); handshakeRef.current = null;
    void prepareWebSession()
      .then(() => createClientPreviewSession(detail.package_id))
      .then((value) => {
        if (!active) return;
        handshakeRef.current = {
          sessionId: value.session_id,
          nonce: value.channel_nonce,
          expiresAt: new Date(value.expires_at).getTime(),
          consumed: false,
        };
        setSession(value); setStatus('HANDSHAKE');
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : '无法创建 Client 预览会话'); setStatus('ERROR');
      });
    return () => { active = false; };
  }, [detail.package_id, detail.release_id]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const state = handshakeRef.current;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!state || !frameWindow || consumeInFlight.current || !validatePreviewHandshake(state, event, frameWindow)) return;
      const payload = event.data as { security_report: PreviewIsolationReport };
      consumeInFlight.current = true;
      void consumeClientPreviewSession(state.sessionId, state.nonce)
        .then(() => {
          if (!handshakeRef.current || handshakeRef.current !== state || iframeRef.current?.contentWindow !== event.source) return;
          state.consumed = true;
          state.nonce = '';
          setReport(payload.security_report);
          const channel = new MessageChannel();
          bindPreviewCapabilities(channel.port1, iframeRef.current);
          (event.source as Window).postMessage({ type: 'lingfang.preview.ready.v1', session_id: state.sessionId }, '*', [channel.port2]);
          setStatus('READY');
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : '预览握手失败'); setStatus('ERROR');
        })
        .finally(() => { consumeInFlight.current = false; });
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  let src = '';
  let configurationError = '';
  try { if (session) src = buildPreviewIframeUrl(previewOrigin(), session, window.location.origin); }
  catch (cause) { configurationError = cause instanceof Error ? cause.message : '预览源配置无效'; }
  const visibleError = error || configurationError;
  const visibleStatus = configurationError ? 'ERROR' : status;

  return <section className="preview client-preview" data-mode="CLIENT_SANDBOX" data-preview-status={visibleStatus}>
    <div className="trial-heading"><div><p className="eyebrow">Opaque Client Sandbox</p><h2>浏览器沙箱预览</h2></div><span className={`status status-${visibleStatus.toLowerCase()}`}>{previewStatus(visibleStatus)}</span></div>
    <p>发行版在独立预览源运行；沙箱不包含 <code>allow-same-origin</code>，不会收到主站 Cookie 或认证 token。</p>
    {visibleError && <div className="error" role="alert">{visibleError}</div>}
    {src && <iframe
      ref={iframeRef}
      className="client-preview-frame"
      title={`${detail.name} 安全预览`}
      src={src}
      sandbox={PREVIEW_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'"
    />}
    {report && <p className="isolation-ok" role="status">已验证父页面 DOM、storage、token 与预览源存储均不可读。</p>}
  </section>;
}

export function previewOrigin(configured = import.meta.env.VITE_PLUGIN_PREVIEW_ORIGIN as string | undefined): string {
  const value = configured || (import.meta.env.DEV ? 'http://localhost:19007' : '');
  if (!value) throw new Error('未配置独立 Client 预览源');
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.origin !== value.replace(/\/$/, '') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('Client 预览源必须是精确 HTTPS origin（本地开发可使用 localhost HTTP）');
  }
  return url.origin;
}

export function buildPreviewIframeUrl(origin: string, session: WebPreviewSession, parentOrigin: string): string {
  const preview = new URL(origin);
  if (preview.origin === new URL(parentOrigin).origin) throw new Error('Client 预览源必须与 Web 主站 origin 分离');
  preview.pathname = `/sessions/${encodeURIComponent(session.session_id)}/index.html`;
  preview.hash = new URLSearchParams({ session_id: session.session_id, nonce: session.channel_nonce }).toString();
  return preview.toString();
}

function bindPreviewCapabilities(port: MessagePort, frame: HTMLIFrameElement): void {
  port.onmessage = (event) => {
    const request = record(event.data);
    if (request.type !== 'lingfang.preview.capability.v1' || typeof request.request_id !== 'string' || typeof request.capability !== 'string') return;
    if (!previewCapabilityAllowed(request.capability)) {
      reply(port, request.request_id, false, undefined, { code: 'preview_capability_denied', message: '该能力不可在 Web 预览中使用' });
      return;
    }
    if (request.capability === 'ui.view') {
      reply(port, request.request_id, true, { width: frame.clientWidth, height: frame.clientHeight });
      return;
    }
    reply(port, request.request_id, false, undefined, { code: 'preview_capability_unavailable', message: '该预览资源未提供可读取的制品引用' });
  };
  port.start();
}

function reply(port: MessagePort, requestId: string, ok: boolean, result?: unknown, error?: { code: string; message: string }): void {
  port.postMessage({ type: 'lingfang.preview.capability.result.v1', request_id: requestId, ok, ...(ok ? { result } : { error }) });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function previewStatus(status: string): string {
  return ({ LOADING: '创建会话', HANDSHAKE: '安全握手', READY: '预览已连接', ERROR: '预览不可用' } as Record<string, string>)[status] || status;
}
