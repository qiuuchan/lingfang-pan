// 保护 release-signing 产出的 minisign 签名结构与桌面 minisign-verify 0.2 crate 完全兼容。
// 该测试用 Node 复刻 crate 的 Signature::decode + PublicKey::verify 逻辑，确保：
//  - 4 行格式、bin1 长度 74、算法字节 0x45 0x44（预哈希）、keyId 一致；
//  - 主签名 = Ed25519(BLAKE2b-512(msg)) 且全局签名 = Ed25519(主签名 ‖ 可信注释载荷) 均验过。
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { signReleaseArtifact, RELEASE_SIGNING_KEY_ENV } from './release-signing';

/** 用真 Ed25519 密钥对拼出一份合法的 minisign 私钥文本，并导出对应公钥 base64（42 字节结构）。 */
function makeMinisignKey(): { secretText: string; pubB64: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url');
  const pk = Buffer.from(jwk.x, 'base64url');
  const keynum = randomBytes(8);
  const secBin = Buffer.concat([keynum, seed, pk]); // 72 字节：keynum(8)+seed(32)+pk(32)
  const secretText = `untrusted comment: test key\n${secBin.toString('base64')}\n`;
  // 公钥文件结构：算法(2)=0x45 0x64 + keynum(8) + pk(32) = 42 字节（与桌面 from_base64 一致）。
  const pubBin = Buffer.concat([Buffer.from([0x45, 0x64]), keynum, pk]);
  return { secretText, pubB64: pubBin.toString('base64') };
}

/** Node 复刻 minisign-verify 0.2 验签（与桌面同款）。返回 null 表示通过，否则错误字符串。 */
function verifyCrateEquivalent(pubB64: string, sigText: string, message: Buffer): string | null {
  const { createPublicKey, verify } = require('node:crypto');
  const pubBin = Buffer.from(pubB64, 'base64');
  if (pubBin.length !== 42) return `pub len ${pubBin.length}`;
  const keyId = pubBin.subarray(2, 10);
  const pk = pubBin.subarray(10, 42);
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk]);
  const pubKeyObj = createPublicKey({ key: der, format: 'der', type: 'spki' });

  const lines = sigText.split(/\r?\n/);
  if (lines.length < 4) return 'line count';
  const bin1 = Buffer.from(lines[1], 'base64');
  if (bin1.length !== 74) return `bin1 len ${bin1.length}`;
  if (bin1[0] !== 0x45 || bin1[1] !== 0x44) return 'alg';
  const sigKeyId = bin1.subarray(2, 10);
  if (Buffer.compare(sigKeyId, keyId) !== 0) return 'keyId mismatch';
  const mainSig = bin1.subarray(10, 74);
  const trustedLine = lines[2];
  if (!trustedLine.startsWith('trusted comment: ')) return 'no trusted comment';
  const globalSig = Buffer.from(lines[3], 'base64');
  if (globalSig.length !== 64) return `global len ${globalSig.length}`;

  const prehash = createHash('blake2b512').update(message).digest();
  if (!verify(null, prehash, pubKeyObj, mainSig)) return 'main sig invalid';
  const payload = trustedLine.slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([mainSig, Buffer.from(payload, 'utf8')]), pubKeyObj, globalSig)) {
    return 'global sig invalid';
  }
  return null;
}

describe('signReleaseArtifact (minisign compat)', () => {
  const saved = process.env[RELEASE_SIGNING_KEY_ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[RELEASE_SIGNING_KEY_ENV];
    else process.env[RELEASE_SIGNING_KEY_ENV] = saved;
  });

  it('returns empty string when key not configured (backward compatible)', () => {
    delete process.env[RELEASE_SIGNING_KEY_ENV];
    expect(signReleaseArtifact(Buffer.from('any'))).toBe('');
  });

  it('produces a prehashed minisign signature that round-trips through crate-equivalent verify', () => {
    const { secretText, pubB64 } = makeMinisignKey();
    process.env[RELEASE_SIGNING_KEY_ENV] = secretText;
    const message = Buffer.from('LingFang-Setup-1.0.0.exe bytes');
    const sig = signReleaseArtifact(message);
    expect(sig.split(/\r?\n/).length).toBeGreaterThanOrEqual(4);
    expect(verifyCrateEquivalent(pubB64, sig, message)).toBeNull();
  });
});
