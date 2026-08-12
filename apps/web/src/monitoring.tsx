/**
 * web 端全局错误上报（P3-1/P3-2）。
 *
 * - `VITE_SENTRY_DSN` 未配置时降级为 console.error 兜底（不崩溃、不静默）。
 * - 上报前经轻量脱敏：剥离 Authorization / token / secret 等凭据字段。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';

const REDACTED = '<redacted>';
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|x-.*token|token|secret|password|passwd|apikey|api_key|privatekey|private_key|accesskey|access_key)$/i;

function scrub(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : scrub(v);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (typeof value === 'string') {
    if (/^Bearer\s+/i.test(value) || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/.test(value))
      return REDACTED;
    if (/^[0-9a-fA-F]{16,}$/.test(value.trim())) return REDACTED;
  }
  return value;
}

export const sentryEnabled = Boolean(import.meta.env.VITE_SENTRY_DSN);

export function initSentry(): void {
  if (!sentryEnabled) {
    console.warn(
      '[Sentry] VITE_SENTRY_DSN 未配置：错误上报降级为 console 兜底（不静默、不崩溃）。'
    );
    return;
  }
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    beforeSend(event) {
      if (event.request?.headers) {
        event.request.headers = scrub(event.request.headers) as typeof event.request.headers;
      }
      if (event.contexts) {
        event.contexts = scrub(event.contexts) as typeof event.contexts;
      }
      return event;
    },
  });
}

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  const safe = scrub(context);
  if (!sentryEnabled) {
    console.error(
      '[Sentry fallback]',
      error instanceof Error ? error.stack || error.message : String(error),
      JSON.stringify(safe)
    );
    return;
  }
  Sentry.captureException(error, { contexts: { report: safe as Record<string, unknown> } });
}

/** 进程级（非 React render）未捕获错误 / promise rejection 兜底上报。 */
export function installGlobalHandlers(): void {
  window.addEventListener('error', (e) =>
    reportError(e.error ?? new Error(e.message), { phase: 'window.error' })
  );
  window.addEventListener('unhandledrejection', (e) =>
    reportError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)), {
      phase: 'unhandledrejection',
    })
  );
}

interface BoundaryProps {
  children: ReactNode;
}
interface BoundaryState {
  hasError: boolean;
}

/** React render 阶段异常边界：捕获后上报 + 渲染兜底 UI。 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, { phase: 'react', componentStack: info.componentStack ?? '' });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main>
          <div className="error" role="alert">
            页面渲染出错，请刷新重试。若持续出现，请联系支持。
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
