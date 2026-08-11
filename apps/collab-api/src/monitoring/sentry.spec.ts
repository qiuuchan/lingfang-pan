import { afterEach, describe, expect, it, vi } from 'vitest';

const captureException = vi.fn();
const init = vi.fn();

vi.mock('@sentry/node', () => ({
  init,
  captureException,
}));

// 由于 sentryEnabled / initialized 在模块加载期求值，每个用例用独立模块状态：
// vi.resetModules() + vi.stubEnv + 动态 import。

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  captureException.mockClear();
  init.mockClear();
});

describe('collab-api 全局错误上报 (sentry)', () => {
  it('正向：SENTRY_DSN 配置时，reportError 调用 Sentry.captureException', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://example@sentry.io/1');
    vi.stubEnv('NODE_ENV', 'test');
    const { reportError } = await import('./sentry');
    const err = new Error('boom');
    reportError(err, { requestId: 'r1', userId: 'u1' });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured, scope] = captureException.mock.calls[0];
    expect(captured).toBe(err);
    // 上下文被脱敏层处理过（不含原始凭据外泄）
    expect(scope.contexts.report).toMatchObject({ requestId: 'r1', userId: 'u1' });
  });

  it('反向（不崩溃、不静默）：SENTRY_DSN 未配置时，reportError 不抛且 console.error 可见', async () => {
    vi.stubEnv('SENTRY_DSN', ''); // 清空
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { reportError } = await import('./sentry');

    expect(() => reportError(new Error('boom'), { requestId: 'r2' })).not.toThrow();
    expect(captureException).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[Sentry fallback]');
    expect(logged).toContain('r2');
  });

  it('反向（脱敏）：带入 Authorization 上下文上报时，令牌不会进入捕获范围', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://example@sentry.io/1');
    const { reportError } = await import('./sentry');
    reportError(new Error('x'), {
      requestId: 'r3',
      // 模拟被脱敏层剥离前的敏感字段（reportError 内部会先 redact）
      headers: { authorization: 'Bearer eyJ.should.not.leak' },
    } as never);
    const [, scope] = captureException.mock.calls[0];
    expect(JSON.stringify(scope)).not.toContain('eyJ');
  });

  it('initSentry 仅在 DSN 存在时调用 Sentry.init', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://example@sentry.io/1');
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('initSentry 在 DSN 缺失时不调用 Sentry.init（降级兜底，不崩溃）', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initSentry } = await import('./sentry');
    expect(() => initSentry()).not.toThrow();
    expect(init).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
