/**
 * 上报前隐私脱敏层（P3-1/P3-2 反向用例核心）。
 *
 * Sentry / 崩溃上报携带请求上下文时，必须剥离凭据类字段，避免 JWT、明文密钥、
 * 令牌经第三方上报通道泄漏。本模块为纯函数，可独立单测，不依赖任何上报 SDK。
 */

const REDACTED = '<redacted>';

// 字段名（大小写不敏感）命中即整字段脱敏。
const SENSITIVE_KEY_RE =
  /^(authorization|cookie|set-cookie|x-.*token|token|secret|password|passwd|apikey|api_key|privatekey|private_key|accesskey|access_key)$/i;

// 值层面的令牌特征：Bearer JWT、长十六进制密钥等。
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * 剥离单个值的敏感令牌特征（如 Bearer JWT）。返回脱敏后的字符串。
 * 非字符串原样返回（调用方负责决定是否整体脱敏）。
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Bearer JWT：整段替换为占位符，避免 eyJ 子串泄漏。
    if (/^Bearer\s+/i.test(value) || JWT_RE.test(value)) {
      return REDACTED;
    }
    // 长十六进制密钥（>=16 位连续 hex，常见 API key / 加密密钥形态）。
    if (/^[0-9a-fA-F]{16,}$/.test(value.trim())) {
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v));
  }
  if (value && typeof value === 'object') {
    return scrubObject(value as Record<string, unknown>);
  }
  return value;
}

/** 递归脱敏对象：命中敏感 key 的字段整体替换，其余递归扫描值中的令牌特征。 */
export function scrubObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(value);
  }
  return out;
}

/**
 * 对上报事件附加上下文做脱敏。专为 Sentry `beforeSend` / `beforeSendTransaction`
 * 设计：传入原始上下文对象，返回脱敏后的副本（不修改入参）。
 */
export function redactContext(context: Record<string, unknown>): Record<string, unknown> {
  return scrubObject(context);
}

export { REDACTED };
