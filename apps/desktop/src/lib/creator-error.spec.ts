import { describe, expect, it } from 'vitest';
import { fromRunResult, toCreatorError, toUploadError } from '@/lib/creator-error';
import type { ApiError } from '@/lib/api';

function makeApiError(message: string, code?: string): ApiError {
  const err = new Error(message) as ApiError;
  err.code = code;
  return err;
}

describe('toCreatorError', () => {
  it('cli_start_failed 映射为可重试错误', () => {
    const err = toCreatorError('cli_start_failed', new Error('spawn failed'));
    expect(err.level).toBe('error');
    expect(err.title).toBe('无法启动本地代码助手');
    expect(err.detail).toContain('API Key');
    expect(err.retryable).toBe(true);
    expect(err.raw).toContain('spawn failed');
  });

  it('interpreter_missing 映射为不可重试错误', () => {
    const err = toCreatorError('interpreter_missing', new Error('node not found'));
    expect(err.kind).toBe('interpreter_missing');
    expect(err.title).toBe('未检测到运行环境');
    expect(err.retryable).toBe(false);
  });

  it('run_timeout 映射为可重试错误', () => {
    const err = toCreatorError('run_timeout', new Error('超时'));
    expect(err.kind).toBe('run_timeout');
    expect(err.retryable).toBe(true);
  });
});

describe('toUploadError', () => {
  it('deduplicated 降级为 info 且不可重试', () => {
    const err = toUploadError(makeApiError('已存在', 'deduplicated'), 'upload');
    expect(err.level).toBe('info');
    expect(err.title).toContain('已存在');
    expect(err.retryable).toBe(false);
    expect(err.kind).toBe('upload_failed');
  });

  it('提交市场失败动作的 kind 为 submit_market_failed', () => {
    const err = toUploadError(makeApiError('网络错误'), 'submit');
    expect(err.kind).toBe('submit_market_failed');
    expect(err.level).toBe('error');
    expect(err.retryable).toBe(true);
  });

  it('未授权错误提示重新登录且不可重试', () => {
    const err = toUploadError(makeApiError('unauthorized', 'unauthorized'), 'upload');
    expect(err.title).toContain('登录');
    expect(err.retryable).toBe(false);
  });
});

describe('fromRunResult', () => {
  it('interpreter_missing 解析为对应 kind 并展示探测路径', () => {
    const err = fromRunResult({ ok: false, failure: 'interpreter_missing', interpreter: '/usr/bin/node' });
    expect(err.kind).toBe('interpreter_missing');
    expect(err.retryable).toBe(false);
    expect(err.detail).toContain('/usr/bin/node');
  });

  it('timeout 解析为可重试', () => {
    const err = fromRunResult({ ok: false, failure: 'timeout' });
    expect(err.kind).toBe('run_timeout');
    expect(err.retryable).toBe(true);
  });

  it('成功结果兜底为 unknown', () => {
    const err = fromRunResult({ ok: true });
    expect(err.kind).toBe('unknown');
    expect(err.level).toBe('info');
  });
});
