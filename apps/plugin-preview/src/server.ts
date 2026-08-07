import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { PREVIEW_BRIDGE_SOURCE } from './bridge';

export type PreviewOriginConfig = {
  internalOrigin: string;
  serviceKey: string;
  webAppOrigins: string[];
  publicOrigin?: string;
  fetchImplementation?: typeof fetch;
};

export function createPreviewOriginServer(input: PreviewOriginConfig) {
  const config = validateConfig(input);
  return createServer((request, response) => {
    void handleRequest(config, request, response).catch(() =>
      sendError(response, 502, 'preview_upstream_failed')
    );
  });
}

async function handleRequest(
  config: Required<
    Pick<
      PreviewOriginConfig,
      'internalOrigin' | 'serviceKey' | 'webAppOrigins' | 'fetchImplementation'
    >
  > &
    Pick<PreviewOriginConfig, 'publicOrigin'>,
  request: IncomingMessage,
  response: ServerResponse
) {
  applySecurityHeaders(response, config.webAppOrigins);
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return sendError(response, 405, 'method_not_allowed');
  const url = new URL(request.url || '/', 'http://preview.invalid');
  if (url.pathname === '/health')
    return send(
      response,
      200,
      'application/json; charset=utf-8',
      Buffer.from('{"ok":true}'),
      request.method === 'HEAD'
    );
  if (url.pathname === '/_lingfang/bridge.js')
    return send(
      response,
      200,
      'text/javascript; charset=utf-8',
      Buffer.from(PREVIEW_BRIDGE_SOURCE),
      request.method === 'HEAD'
    );

  const match = /^\/sessions\/([0-9a-f-]{36})\/(.*)$/i.exec(url.pathname);
  if (!match) return sendError(response, 404, 'preview_resource_not_found');
  const sessionId = match[1]!;
  const path = decodeAssetPath(match[2]!);
  if (path === null) return sendError(response, 400, 'preview_asset_path_invalid');
  const requestedPath = path === 'index.html' ? '' : path;
  const upstreamUrl = new URL(
    `/api/internal/plugin-preview/sessions/${sessionId}/asset`,
    config.internalOrigin
  );
  if (requestedPath) upstreamUrl.searchParams.set('path', requestedPath);
  const upstream = await config.fetchImplementation(upstreamUrl, {
    method: 'GET',
    headers: {
      accept: '*/*',
      'x-lingfang-preview-service-key': config.serviceKey,
    },
    redirect: 'error',
  });
  if (!upstream.ok)
    return sendError(
      response,
      upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
      'preview_resource_unavailable'
    );
  const body = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const isEntry = upstream.headers.get('x-lingfang-preview-entry') === '1';
  const entryPath = decodeHeaderPath(upstream.headers.get('x-lingfang-preview-entry-path'));
  const output =
    isEntry && contentType.toLowerCase().startsWith('text/html')
      ? injectPreviewBootstrap(body.toString('utf8'), sessionId, entryPath)
      : body;
  if (isEntry)
    response.setHeader(
      'content-security-policy',
      contentSecurityPolicy(config.webAppOrigins, output.toString('utf8'))
    );
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('content-type', contentType);
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('x-content-type-options', 'nosniff');
  response.removeHeader('set-cookie');
  return send(response, 200, contentType, output, request.method === 'HEAD');
}

function validateConfig(input: PreviewOriginConfig) {
  if (!input.serviceKey || input.serviceKey.length < 32)
    throw new Error('PLUGIN_PREVIEW_SERVICE_KEY must contain at least 32 characters');
  const internalOrigin = exactOrigin(input.internalOrigin, 'COLLAB_API_INTERNAL_ORIGIN');
  const webAppOrigins = [
    ...new Set(input.webAppOrigins.map((origin) => exactOrigin(origin, 'PREVIEW_WEB_APP_ORIGINS'))),
  ];
  if (webAppOrigins.length === 0)
    throw new Error('PREVIEW_WEB_APP_ORIGINS must contain at least one origin');
  const publicOrigin = input.publicOrigin
    ? exactOrigin(input.publicOrigin, 'PLUGIN_PREVIEW_PUBLIC_ORIGIN')
    : undefined;
  if (publicOrigin && webAppOrigins.includes(publicOrigin))
    throw new Error('plugin preview origin must differ from every Web app origin');
  return {
    ...input,
    internalOrigin,
    webAppOrigins,
    publicOrigin,
    fetchImplementation: input.fetchImplementation || fetch,
  };
}

function exactOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  return url.origin;
}

function decodeAssetPath(raw: string): string | null {
  try {
    const parts = raw.split('/').map((part) => decodeURIComponent(part));
    if (
      parts.some(
        (part) =>
          !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')
      )
    )
      return null;
    const path = parts.join('/');
    return path.length <= 512 ? path : null;
  } catch {
    return null;
  }
}

function decodeHeaderPath(value: string | null): string {
  if (!value) return 'index.html';
  try {
    return decodeURIComponent(value);
  } catch {
    return 'index.html';
  }
}

function injectPreviewBootstrap(html: string, sessionId: string, entryPath: string): Buffer {
  const slash = entryPath.lastIndexOf('/');
  const directory = slash >= 0 ? entryPath.slice(0, slash + 1) : '';
  const base = `<base href="/sessions/${sessionId}/${escapeAttribute(directory)}">`;
  // Parser-blocking by design: the bridge must clear the nonce fragment and
  // freeze window.sdk before any reviewed plugin script can execute.
  const bridge = '<script src="/_lingfang/bridge.js"></script>';
  const injection = `${base}${bridge}`;
  const output = /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${injection}`)
    : `${injection}${html}`;
  return Buffer.from(output);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineScriptHashes(html: string): string[] {
  const values = new Set<string>();
  const expression = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(html))) {
    values.add(
      `'sha256-${createHash('sha256')
        .update(match[1] || '')
        .digest('base64')}'`
    );
  }
  return [...values];
}

function contentSecurityPolicy(webAppOrigins: string[], html = ''): string {
  const scripts = ["'self'", ...inlineScriptHashes(html)].join(' ');
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'self'",
    `frame-ancestors ${webAppOrigins.join(' ')}`,
  ].join('; ');
}

function applySecurityHeaders(response: ServerResponse, webAppOrigins: string[]): void {
  response.setHeader('content-security-policy', contentSecurityPolicy(webAppOrigins));
  response.setHeader(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), fullscreen=()'
  );
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('origin-agent-cluster', '?1');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('x-content-type-options', 'nosniff');
}

function sendError(response: ServerResponse, status: number, code: string): void {
  send(
    response,
    status,
    'application/json; charset=utf-8',
    Buffer.from(JSON.stringify({ code })),
    false
  );
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  head: boolean
): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader('content-type', contentType);
  response.setHeader('content-length', String(body.length));
  response.end(head ? undefined : body);
}
