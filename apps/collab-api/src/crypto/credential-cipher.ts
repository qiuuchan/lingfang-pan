// apiKey 加密工具：AES-256-GCM 对称加密，密文打包为 base64(iv(12B) || tag(16B) || ciphertext)。
//
// 设计契约（见 design.md §3）：
//  - 密钥从 env LLM_KEY_ENCRYPTION_KEY 读取（64 位 hex → 32 字节，openssl rand -hex 32 生成）。
//  - 每次加密生成新 IV（12 字节随机），保证同明文两次密文不同（语义安全）。
//  - 解密校验 GCM tag，失败抛 AppError(500,'llm_key_decrypt_failed')。
//  - 密钥缺失时 requireKeyEncryptionKey 返回 null（由 main.ts 决定 throw/warn，不在此处生成兜底密钥）。
//
// 这是用户凭据保护（非平台安全控制）：库泄漏拿到的是密文，需密钥才能还原明文。
// 密钥不入库、不入 git、不在日志输出。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../common';

/** GCM 推荐 IV 长度（12 字节，96 位）。 */
const IV_LEN = 12;
/** GCM 认证 tag 长度（16 字节，128 位）。 */
const TAG_LEN = 16;
/** AES-256 密钥长度（32 字节，256 位）。 */
const KEY_LEN = 32;

/** 启动期 fail-fast 解析密钥。
 *  - 缺失或格式错（非 64 位 hex）返回 null（由 main.ts 决定生产 throw / dev warn）。
 *  - 合法时返回 32 字节 Buffer。 */
export function requireKeyEncryptionKey(): Buffer | null {
  const raw = process.env.LLM_KEY_ENCRYPTION_KEY;
  if (!raw) return null;
  // 必须 64 位 hex（32 字节）。大小写不敏感。
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_LEN) return null;
  return key;
}

/** 业务调用期获取密钥：解析失败时抛 AppError(500,'llm_key_not_configured')。
 *  供 LlmService 在 encryptApiKey/decryptApiKey 调用前取密钥用（而非每次手动判 null）。
 *  main.ts 启动断言已覆盖「生产缺密钥直接 throw」；此处覆盖「dev warn 后用户仍触发加解密」的兜底。 */
export function getLlmKey(): Buffer {
  const key = requireKeyEncryptionKey();
  if (!key) {
    throw new AppError(500, 'llm_key_not_configured', '服务端未配置 LLM apiKey 加密密钥');
  }
  return key;
}

/** 加密 apiKey：返回 base64(iv(12B) || tag(16B) || ciphertext)，每次新 IV。
 *  调用方需保证 key 已校验（来自 requireKeyEncryptionKey 非 null）。 */
export function encryptApiKey(plain: string, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new AppError(500, 'llm_key_not_configured', 'apiKey 加密密钥长度不合法');
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 打包顺序：iv || tag || ciphertext（解密端按固定偏移切分）。
  const packed = Buffer.concat([iv, tag, ciphertext]);
  return packed.toString('base64');
}

/** 解密 apiKey：校验 GCM tag，失败抛 AppError(500,'llm_key_decrypt_failed')。
 *  - 密钥不匹配/密文被篡改/IV 被篡改 → tag 校验失败 → 抛错（不返回半解密数据）。
 *  - packed 格式不合法（长度不足、非 base64）→ 抛 llm_key_decrypt_failed。 */
export function decryptApiKey(packed: string, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new AppError(500, 'llm_key_not_configured', 'apiKey 加密密钥长度不合法');
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(packed, 'base64');
  } catch {
    throw new AppError(500, 'llm_key_decrypt_failed', 'apiKey 密文 base64 解析失败');
  }
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new AppError(500, 'llm_key_decrypt_failed', 'apiKey 密文长度不合法');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    // 不区分「密钥错」与「密文篡改」，统一返回 decrypt_failed（避免信息泄漏）。
    throw new AppError(500, 'llm_key_decrypt_failed', 'apiKey 解密失败');
  }
}

/** 脱敏 apiKey：返回非敏感展示串（写库 apiKeyHint + GET 列表展示，零解密）。
 *  - len >= 12：前3 + *** + 后4（如 sk-1abc...wxyz → sk-***wxyz）
 *  - len >= 6 ：*** + 后2
 *  - 否则    ：***
 *  单测断言：输出永不暴露连续 >=6 个明文字符。 */
export function maskApiKey(plain: string): string {
  const s = plain || '';
  if (s.length >= 12) return `${s.slice(0, 3)}***${s.slice(-4)}`;
  if (s.length >= 6) return `***${s.slice(-2)}`;
  return '***';
}

/** 指纹 apiKey：sha256(明文).slice(0,16)，稳定标识「这是哪个 key」。
 *  - 同明文 → 同指纹；明文微小变化 → 指纹剧变（雪崩效应）。
 *  - 16 位 hex = 64 位熵，足以区分租户内不同 key（碰撞概率可忽略）。
 *  - 不泄漏明文（sha256 单向）。 */
export function fingerprintApiKey(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex').slice(0, 16);
}
