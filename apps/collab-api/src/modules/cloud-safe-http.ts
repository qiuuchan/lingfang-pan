import { Injectable, Optional } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from '../common';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type SafeHttpResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type PinnedHttpsRequest = {
  url: URL;
  address: ResolvedAddress;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  signal: AbortSignal;
  maxHeaderBytes: number;
};

export type PinnedHttpsResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close?: () => void;
};

export type SafeHttpTransport = (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;

export type SafeOutboundHttpOptions = {
  resolver?: SafeHttpResolver;
  transport?: SafeHttpTransport;
  allowedPorts?: readonly number[];
  maxUrlLength?: number;
  maxDnsAnswers?: number;
  maxHeaderBytes?: number;
  defaultTimeoutMs?: number;
  defaultResponseLimitBytes?: number;
};

export type SafeOutboundRequest = {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  responseLimitBytes?: number;
  signal?: AbortSignal;
};

export type SafeOutboundResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  resolvedAddress: ResolvedAddress;
};

const DEFAULT_ALLOWED_PORTS = [443, 8443] as const;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function unsafe(message = 'Cloud endpoint 地址不安全'): AppError {
  return new AppError(400, 'cloud_endpoint_unsafe', message);
}

function parseIpv4(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const parsed = parseIpv4(base);
  if (parsed === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (parsed & mask);
}

const DENIED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function expandIpv6(address: string): bigint | null {
  if (isIP(address) !== 6) return null;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] => {
    if (!half) return [];
    const pieces = half.split(':');
    const result: number[] = [];
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (ipv4 === null) return [];
        result.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      } else {
        const value = Number.parseInt(piece, 16);
        if (!Number.isInteger(value) || value < 0 || value > 0xffff) return [];
        result.push(value);
      }
    }
    return result;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words =
    halves.length === 2 ? [...left, ...Array(Math.max(0, omitted)).fill(0), ...right] : left;
  if (words.length !== 8) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

function ipv6InCidr(value: bigint, base: string, prefix: number): boolean {
  const parsed = expandIpv6(base);
  if (parsed === null) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === parsed >> shift;
}

const DENIED_IPV6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

export function isPublicEndpointAddress(address: string): boolean {
  const unwrapped = address.replace(/^\[|\]$/g, '');
  const v4 = parseIpv4(unwrapped);
  if (v4 !== null)
    return !DENIED_IPV4_RANGES.some(([base, prefix]) => ipv4InCidr(v4, base, prefix));
  const v6 = expandIpv6(unwrapped);
  if (v6 === null) return false;
  // IPv4-mapped IPv6 must be classified using the embedded IPv4 address.
  if (ipv6InCidr(v6, '::ffff:0:0', 96)) {
    const mapped = Number(v6 & 0xffffffffn) >>> 0;
    return !DENIED_IPV4_RANGES.some(([base, prefix]) => ipv4InCidr(mapped, base, prefix));
  }
  return !DENIED_IPV6_RANGES.some(([base, prefix]) => ipv6InCidr(v6, base, prefix));
}

export const defaultSafeHttpResolver: SafeHttpResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

export const defaultSafeHttpTransport: SafeHttpTransport = (request) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: request.address.address,
        family: request.address.family,
        port: request.url.port ? Number(request.url.port) : 443,
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers: { ...request.headers, host: request.url.host },
        servername: request.url.hostname,
        rejectUnauthorized: true,
        maxHeaderSize: request.maxHeaderBytes,
        agent: false,
        signal: request.signal,
      },
      (response) =>
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          close: () => response.destroy(),
        })
    );
    req.once('error', reject);
    if (request.body.length > 0) req.write(request.body);
    req.end();
  });

@Injectable()
export class SafeOutboundHttpClient {
  private readonly resolver: SafeHttpResolver;
  private readonly transport: SafeHttpTransport;
  private readonly allowedPorts: ReadonlySet<number>;
  private readonly maxUrlLength: number;
  private readonly maxDnsAnswers: number;
  private readonly maxHeaderBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultResponseLimitBytes: number;

  constructor(@Optional() options: SafeOutboundHttpOptions = {}) {
    this.resolver = options.resolver ?? defaultSafeHttpResolver;
    this.transport = options.transport ?? defaultSafeHttpTransport;
    this.allowedPorts = new Set(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
    this.maxUrlLength = options.maxUrlLength ?? 2048;
    this.maxDnsAnswers = options.maxDnsAnswers ?? 16;
    this.maxHeaderBytes = options.maxHeaderBytes ?? 16 * 1024;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.defaultResponseLimitBytes = options.defaultResponseLimitBytes ?? 1024 * 1024;
  }

  validateUrl(raw: string): URL {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > this.maxUrlLength)
      throw unsafe();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw unsafe();
    }
    if (url.protocol !== 'https:' || !url.hostname) throw unsafe('Cloud endpoint 只允许 HTTPS');
    if (url.username || url.password) throw unsafe('Cloud endpoint URL 不允许内嵌凭据');
    if (url.hash) throw unsafe('Cloud endpoint URL 不允许 fragment');
    const hostname = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw unsafe();
    if (isIP(hostname) !== 0 && !isPublicEndpointAddress(hostname)) throw unsafe();
    url.hostname = hostname;
    const port = url.port ? Number(url.port) : 443;
    if (!Number.isInteger(port) || !this.allowedPorts.has(port))
      throw unsafe('Cloud endpoint 端口不在允许列表');
    return url;
  }

  async request(input: SafeOutboundRequest): Promise<SafeOutboundResponse> {
    const url = this.validateUrl(input.url);
    const addresses = await this.resolveAndValidate(url.hostname);
    const selected = [...addresses].sort(
      (a, b) => a.family - b.family || a.address.localeCompare(b.address)
    )[0];
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? this.defaultTimeoutMs, 1),
      MAX_TIMEOUT_MS
    );
    const responseLimitBytes = Math.min(
      Math.max(input.responseLimitBytes ?? this.defaultResponseLimitBytes, 1),
      MAX_RESPONSE_BYTES
    );
    const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body ?? '', 'utf8');
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, timeoutMs);
    try {
      const transportRequest = this.transport({
        url,
        address: selected,
        method: input.method ?? 'GET',
        headers: input.headers ?? {},
        body,
        signal: controller.signal,
        maxHeaderBytes: this.maxHeaderBytes,
      });
      const response = await Promise.race([
        transportRequest,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          })
        ),
      ]);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.close?.();
        throw new AppError(502, 'cloud_endpoint_redirect_denied', 'Cloud endpoint 不允许重定向');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > responseLimitBytes) {
          response.close?.();
          throw new AppError(502, 'cloud_response_too_large', 'Cloud endpoint 响应超过大小限制');
        }
        chunks.push(bytes);
      }
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        resolvedAddress: selected,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (timedOut) throw new AppError(504, 'cloud_timeout', 'Cloud endpoint 请求超时');
      if (input.signal?.aborted)
        throw new AppError(499, 'cloud_request_cancelled', 'Cloud endpoint 请求已取消');
      throw new AppError(502, 'cloud_endpoint_unavailable', 'Cloud endpoint 当前不可用');
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async resolveAndValidate(hostname: string): Promise<ResolvedAddress[]> {
    const literalFamily = isIP(hostname);
    let answers: ResolvedAddress[];
    try {
      answers = literalFamily
        ? [{ address: hostname, family: literalFamily as 4 | 6 }]
        : await this.resolver(hostname);
    } catch {
      throw new AppError(502, 'cloud_endpoint_unavailable', 'Cloud endpoint DNS 解析失败');
    }
    const unique = [
      ...new Map(answers.map((answer) => [`${answer.family}:${answer.address}`, answer])).values(),
    ];
    if (unique.length === 0 || unique.length > this.maxDnsAnswers)
      throw unsafe('Cloud endpoint DNS 结果不合法');
    for (const answer of unique) {
      if (
        (answer.family !== 4 && answer.family !== 6) ||
        isIP(answer.address) !== answer.family ||
        !isPublicEndpointAddress(answer.address)
      )
        throw unsafe();
    }
    return unique;
  }
}
