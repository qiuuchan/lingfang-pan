// credential-cipher 单测：覆盖加密往返、篡改检测、IV 随机性、脱敏边界、指纹稳定性。
// 对照 design.md §10.1 的 6 个测试用例。
import { describe, expect, it } from 'vitest';
import {
  decryptApiKey,
  encryptApiKey,
  fingerprintApiKey,
  maskApiKey,
  requireKeyEncryptionKey,
} from './credential-cipher';
import { AppError } from '../common';

// 固定测试密钥（32 字节，64 位 hex）。仅测试用，生产用 openssl rand -hex 32。
const TEST_KEY_HEX = '0'.repeat(64);
const TEST_KEY = Buffer.from(TEST_KEY_HEX, 'hex');

describe('credential-cipher', () => {
  it('encrypt_decrypt_roundtrip：加密后解密还原明文', () => {
    const plain = 'sk-test-api-key-1234567890abcdef';
    const packed = encryptApiKey(plain, TEST_KEY);
    // 打包为 base64 字符串，非明文。
    expect(typeof packed).toBe('string');
    expect(packed).not.toContain(plain);
    // 解密还原。
    const decrypted = decryptApiKey(packed, TEST_KEY);
    expect(decrypted).toBe(plain);
  });

  it('tampered_tag_throws：篡改 GCM tag 后解密抛 llm_key_decrypt_failed', () => {
    const plain = 'sk-test-key';
    const packed = encryptApiKey(plain, TEST_KEY);
    const buf = Buffer.from(packed, 'base64');
    // tag 位于 [12, 28)（IV 12B + tag 16B）。
    buf[12] = buf[12] ^ 0xff; // 翻转 tag 首字节
    const tampered = buf.toString('base64');
    try {
      decryptApiKey(tampered, TEST_KEY);
      throw new Error('应抛 llm_key_decrypt_failed');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('llm_key_decrypt_failed');
      expect((e as AppError).status).toBe(500);
    }
  });

  it('tampered_iv_throws：篡改 IV 后解密抛 llm_key_decrypt_failed', () => {
    const plain = 'sk-test-key-xyz';
    const packed = encryptApiKey(plain, TEST_KEY);
    const buf = Buffer.from(packed, 'base64');
    // IV 位于 [0, 12)。篡改 IV 会使 GCM 解密 tag 校验失败（IV 影响 tag 计算）。
    buf[0] = buf[0] ^ 0xff;
    const tampered = buf.toString('base64');
    try {
      decryptApiKey(tampered, TEST_KEY);
      throw new Error('应抛 llm_key_decrypt_failed');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('llm_key_decrypt_failed');
    }
  });

  it('iv_randomness：同明文两次加密密文不同（每次新 IV，语义安全）', () => {
    const plain = 'sk-same-plaintext';
    const packed1 = encryptApiKey(plain, TEST_KEY);
    const packed2 = encryptApiKey(plain, TEST_KEY);
    // 密文整体不同（IV 随机）。
    expect(packed1).not.toBe(packed2);
    // 但都能解出同一明文。
    expect(decryptApiKey(packed1, TEST_KEY)).toBe(plain);
    expect(decryptApiKey(packed2, TEST_KEY)).toBe(plain);
    // 解码后 IV 段不同。
    const iv1 = Buffer.from(packed1, 'base64').subarray(0, 12);
    const iv2 = Buffer.from(packed2, 'base64').subarray(0, 12);
    expect(iv1.equals(iv2)).toBe(false);
  });

  it('mask_boundary：脱敏覆盖 <6 / 6-11 / >=12 三档边界，永不暴露连续 6+ 明文', () => {
    // <6：全 ***。
    expect(maskApiKey('')).toBe('***');
    expect(maskApiKey('abc')).toBe('***');
    expect(maskApiKey('abcde')).toBe('***');
    // 6-11：***后2。
    expect(maskApiKey('abcdef')).toBe('***ef');
    expect(maskApiKey('abcdefghijk')).toBe('***jk');
    // >=12：前3***后4。
    expect(maskApiKey('sk-1abcdefgwxyz')).toBe('sk-***wxyz');
    expect(maskApiKey('abcdefghijkl')).toBe('abc***ijkl');
    // 断言：输出不暴露连续 >=6 个明文字符（取最长连续明文片段）。
    const longKey = 'sk-1234567890abcdefghij';
    const masked = maskApiKey(longKey);
    // masked 形如 sk-***ghij，明文片段 sk-（3）与 ghij（4）均 < 6。
    expect(masked).toBe('sk-***ghij');
    // 通用断言：移除 *** 后的明文片段连续长度 < 6。
    const plainRun = masked.replace(/\*+/g, ' ').split(' ').filter(Boolean);
    for (const run of plainRun) {
      expect(run.length).toBeLessThan(6);
    }
  });

  it('fingerprint_stable：同明文指纹稳定，异明文指纹不同', () => {
    const plain = 'sk-test-key';
    const fp1 = fingerprintApiKey(plain);
    const fp2 = fingerprintApiKey(plain);
    // 稳定。
    expect(fp1).toBe(fp2);
    // 16 位 hex。
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
    // 不同明文不同指纹（雪崩效应）。
    const fpOther = fingerprintApiKey('sk-test-kez');
    expect(fpOther).not.toBe(fp1);
    // 指纹不等于明文，也不含明文。
    expect(fp1).not.toBe(plain);
    expect(fp1).not.toContain(plain);
  });

  it('requireKeyEncryptionKey：合法 hex 解析为 32B，缺失/非法返回 null', () => {
    // 临时改 env。
    const saved = process.env.LLM_KEY_ENCRYPTION_KEY;
    try {
      // 缺失。
      delete process.env.LLM_KEY_ENCRYPTION_KEY;
      expect(requireKeyEncryptionKey()).toBeNull();
      // 非法格式（长度不对）。
      process.env.LLM_KEY_ENCRYPTION_KEY = 'not-hex';
      expect(requireKeyEncryptionKey()).toBeNull();
      process.env.LLM_KEY_ENCRYPTION_KEY = 'abc123';
      expect(requireKeyEncryptionKey()).toBeNull();
      // 合法。
      process.env.LLM_KEY_ENCRYPTION_KEY = 'a'.repeat(64);
      const key = requireKeyEncryptionKey();
      expect(key).not.toBeNull();
      expect(key!.length).toBe(32);
      // 大写 hex 也接受。
      process.env.LLM_KEY_ENCRYPTION_KEY = 'A'.repeat(64);
      const keyUpper = requireKeyEncryptionKey();
      expect(keyUpper).not.toBeNull();
      expect(keyUpper!.length).toBe(32);
    } finally {
      if (saved === undefined) delete process.env.LLM_KEY_ENCRYPTION_KEY;
      else process.env.LLM_KEY_ENCRYPTION_KEY = saved;
    }
  });
});
