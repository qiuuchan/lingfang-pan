import { describe, it, expect } from 'vitest';
import { UpstreamError } from './forwarders';
import {
  remapUpstreamHttpStatus,
  extractUpstreamCause,
  upstreamErrorCode,
  summarizeUpstreamError,
} from './upstream-status-policy';

describe('remapUpstreamHttpStatus', () => {
  it('maps 401/403 (channel key rejected) to 502 so clients retry as transient', () => {
    expect(remapUpstreamHttpStatus(401)).toBe(502);
    expect(remapUpstreamHttpStatus(403)).toBe(502);
  });
  it('passes through other statuses unchanged', () => {
    expect(remapUpstreamHttpStatus(200)).toBe(200);
    expect(remapUpstreamHttpStatus(429)).toBe(429);
    expect(remapUpstreamHttpStatus(500)).toBe(500);
  });
  it('falls back to 502 when status is unknown', () => {
    expect(remapUpstreamHttpStatus(null)).toBe(502);
  });
});

describe('extractUpstreamCause', () => {
  it('returns nulls for non-UpstreamError', () => {
    expect(extractUpstreamCause(new Error('boom'))).toEqual({
      upstreamStatus: null,
      upstreamDetail: null,
    });
  });
  it('extracts message from a JSON error body', () => {
    const e = new UpstreamError(400, 'bad', JSON.stringify({ message: 'schema invalid' }));
    expect(extractUpstreamCause(e)).toEqual({
      upstreamStatus: 400,
      upstreamDetail: 'schema invalid',
    });
  });
  it('falls back to raw body text when body is not JSON', () => {
    const e = new UpstreamError(400, 'bad', 'plain rejection');
    expect(extractUpstreamCause(e)).toEqual({
      upstreamStatus: 400,
      upstreamDetail: 'plain rejection',
    });
  });
});

describe('upstreamErrorCode', () => {
  it('tags non-UpstreamError as upstream_unknown', () => {
    expect(upstreamErrorCode(new Error('x'))).toBe('upstream_unknown');
  });
  it('appends the root-cause detail when present', () => {
    const e = new UpstreamError(429, 'rate', JSON.stringify({ message: 'too many requests' }));
    expect(upstreamErrorCode(e)).toBe('upstream_429:too many requests');
  });
});

describe('summarizeUpstreamError', () => {
  it('remaps status and carries the cause for an UpstreamError', () => {
    const e = new UpstreamError(401, 'rej', JSON.stringify({ message: 'key revoked' }));
    expect(summarizeUpstreamError(e)).toEqual({
      upstreamStatus: 401,
      upstreamDetail: 'key revoked',
      httpStatus: 502,
      errorCode: 'upstream_401:key revoked',
    });
  });
  it('falls back to 502 + upstream_llm_error for non-UpstreamError', () => {
    expect(summarizeUpstreamError(new Error('x'))).toEqual({
      upstreamStatus: null,
      upstreamDetail: null,
      httpStatus: 502,
      errorCode: 'upstream_llm_error',
    });
  });
  it('passes through a 500 without remapping', () => {
    const e = new UpstreamError(500, 'boom', 'server error');
    expect(summarizeUpstreamError(e).httpStatus).toBe(500);
    expect(summarizeUpstreamError(e).errorCode).toBe('upstream_500:server error');
  });
});
