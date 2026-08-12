import { afterEach, describe, expect, it, vi } from 'vitest';

const captureException = vi.fn();
const init = vi.fn();

vi.mock('@sentry/react', () => ({
  init,
  captureException,
}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  captureException.mockClear();
  init.mockClear();
});

describe('collab-admin 全局错误上报 (monitoring)', () => {
  it('正向：VITE_SENTRY_DSN 配置时，reportError 调用 Sentry.captureException', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://example@sentry.io/3');
    const { reportError } = await import('./monitoring');
    const err = new Error('boom');
    reportError(err, { requestId: 'r1' });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0]).toBe(err);
  });

  it('反向（不崩溃、不静默）：DSN 未配置时 reportError 不抛且 console.error 可见', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { reportError } = await import('./monitoring');
    expect(() => reportError(new Error('boom'), { requestId: 'r2' })).not.toThrow();
    expect(captureException).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('[Sentry fallback]');
  });

  it('反向（脱敏）：带入 Authorization 上报时令牌不进入捕获范围', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://example@sentry.io/3');
    const { reportError } = await import('./monitoring');
    reportError(new Error('x'), {
      requestId: 'r3',
      headers: { authorization: 'Bearer eyJ.should.not.leak' },
    } as never);
    const [, scope] = captureException.mock.calls[0];
    expect(JSON.stringify(scope)).not.toContain('eyJ');
  });

  it('initSentry 在 DSN 缺失时不调用 Sentry.init（降级兜底）', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initSentry } = await import('./monitoring');
    expect(() => initSentry()).not.toThrow();
    expect(init).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ErrorBoundary.componentDidCatch 将错误路由到 reportError（DSN 缺失→console 兜底可见）', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('./monitoring');
    const boundary = new mod.ErrorBoundary({ children: null });
    boundary.componentDidCatch(new Error('render boom'), { componentStack: 'at App' });
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[Sentry fallback]');
    expect(logged).toContain('react');
  });
});
