/**
 * collab-api 全局错误上报（P3-1/P3-2）。
 *
 * 设计原则（工单硬性要求）：
 * - `SENTRY_DSN` 未配置时 **不崩溃、不静默**：降级为 console.error 兜底（可见）。
 * - 上报前经脱敏层剥离凭据（JWT / 明文密钥 / 令牌）。
 * - DSN 门控：无 DSN 时 `Sentry` 不参与，避免 SDK 向空 endpoint 发网络请求。
 */
import { resolve } from 'node:path';
import * as Sentry from '@sentry/node';
import { redactContext } from './redact';

/** 读取 package.json 版本号（与 /api/health 单一来源一致）。 */
function readPackageVersion(): string {
  // 运行环境不同，package.json 相对路径不同：
  // - tsx 直接跑 src/main.ts 时 __dirname 指向 src/，package.json 在上级；
  // - vitest 等工具解析模块时 __dirname 更深，需向上多跳。
  // 任一候选命中即返回，全部失败降级为 '0.0.0'（绝不抛，避免阻断上报初始化）。
  const candidates = [
    resolve(__dirname, '..', 'package.json'),
    resolve(__dirname, '..', '..', 'package.json'),
    resolve(__dirname, '..', '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(p) as { version?: string };
      if (pkg?.version) return pkg.version;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return '0.0.0';
}

const SENTRY_DSN = process.env.SENTRY_DSN;
const NODE_ENV = process.env.NODE_ENV || 'development';

/** 是否已启用 Sentry 上报（DSN 存在才启用）。 */
export const sentryEnabled = Boolean(SENTRY_DSN);

let initialized = false;

/** 在应用最早期调用：仅当 DSN 存在时初始化 Sentry。重复调用幂等。 */
export function initSentry(): void {
  if (initialized) return;
  initialized = true;
  if (!sentryEnabled) {
    // 兜底可见：明确告知运维未启用上报，而非静默。
    console.warn(
      '[Sentry] SENTRY_DSN 未配置：错误上报降级为 console 兜底（不静默、不崩溃）。生产环境请配置 SENTRY_DSN。'
    );
    return;
  }
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    release: readPackageVersion(),
    // 上报前脱敏：剥离 Authorization / token / secret 等凭据类字段。
    beforeSend(event) {
      if (event.request?.headers) {
        event.request.headers = redactContext(
          event.request.headers as Record<string, unknown>
        ) as typeof event.request.headers;
      }
      if (event.contexts) {
        event.contexts = redactContext(event.contexts as Record<string, unknown>) as typeof event.contexts;
      }
      return event;
    },
  });
}

export interface ErrorContext {
  requestId?: string;
  method?: string;
  url?: string;
  userId?: string;
  teamId?: string | null;
  phase?: string;
  [key: string]: unknown;
}

/**
 * 上报一个错误。DSN 缺失 → console.error 兜底（不抛、可见）；
 * DSN 存在 → Sentry.captureException（上下文经脱敏层处理）。
 */
export function reportError(error: unknown, context: ErrorContext = {}): void {
  const safeContext = redactContext(context);
  if (!sentryEnabled) {
    console.error(
      '[Sentry fallback]',
      safeContext.phase ? `[${safeContext.phase}]` : '',
      error instanceof Error ? error.stack || error.message : String(error),
      JSON.stringify(safeContext)
    );
    return;
  }
  Sentry.captureException(error, {
    contexts: { report: safeContext as Record<string, unknown> },
  });
}

/** 进程级未捕获异常 / 未处理 rejection 的兜底上报。 */
export function installProcessHandlers(): void {
  process.on('uncaughtException', (err) => reportError(err, { phase: 'uncaughtException' }));
  process.on('unhandledRejection', (reason) =>
    reportError(reason instanceof Error ? reason : new Error(String(reason)), {
      phase: 'unhandledRejection',
    })
  );
}
