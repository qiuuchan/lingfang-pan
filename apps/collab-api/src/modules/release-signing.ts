// 发布者 minisign 签名（安装包真实性 = 防伪造安装包的最后一道关）。
//
// 设计目标（commercial-readiness audit）：桌面自制更新器此前只比对后端下发的 SHA-256，
// 而该值来自同一后端——后端被入侵或响应被中间人篡改时，攻击者可换恶意安装包并同时改写
// sha256。真正的真实性必须由发布者私钥签名、桌面壳用配置的公钥验签来保证。
//
// 本模块在「安装包上传」时，用配置在 env 的 minisign 私钥对安装包字节签名，把 minisign
// 签名文本（.minisig 内容）写入 ReleaseAsset.signature，随 /api/releases/latest 的 asset
// 一并下发；桌面 update.rs 在配置 LINGFANG_UPDATER_PUBKEY 后强制验签（fail-closed）。
//
// 门控（env-gated，不破坏现有行为）：
//  - LINGFANG_RELEASE_SIGNING_KEY 未配置 → 返回空串，signature 留空，与当前无签名行为完全一致。
//  - 已配置但私钥非法/签名失败 → 抛错（fail-closed），让管理员立即发现签名链路损坏，
//    绝不静默下发未签名安装包（否则桌面在配置公钥后会拒绝更新，反而更糟）。
//
// 依赖：仅用 Node 内置 crypto（零新依赖）。Ed25519 私钥通过 JWK {d,x} 重建——minisign 私钥
// 的 64 字节 libsodium 体正好是 seed(32)+pk(32)，可直接取作 d 与 x。签名结构严格对齐
// minisign / minisign-verify crate（桌面侧即 minisign-verify 0.2）：
//   "Ed"(2) + version(1) + keynum(8) + ed25519_sig(64) = 75 字节，base64 后配 untrusted comment 行。
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** env 名：minisign 私钥（.minisign 私钥文件全文，或该文件的路径）。缺省即关闭签名。 */
export const RELEASE_SIGNING_KEY_ENV = 'LINGFANG_RELEASE_SIGNING_KEY';

/**
 * 用 minisign 私钥对 `message`（安装包字节）签名，产出标准 minisign 签名文本。
 *
 * 格式严格对齐桌面侧使用的 minisign-verify 0.2 crate（见其 Signature::decode / PublicKey::verify）：
 *   - 4 行：untrusted comment / base64(bin1=74B) / "trusted comment: ..." / base64(globalSig=64B)
 *   - bin1 = 算法(2)=0x45 0x44(预哈希) + keyId(8) + 主签名(64)
 *   - 主签名 = Ed25519( BLAKE2b-512(message) )；桌面 verify(.., false) 仅接受预哈希签名
 *   - 全局签名 = Ed25519( 主签名(64) ‖ 可信注释载荷 )（防篡改）
 *
 * @returns 完整 .minisig 文本；未配置密钥时返回 ''（关闭，保持现有行为）。
 * @throws 密钥已配置但解析/签名失败（fail-closed，避免静默下发未签名安装包）。
 */
export function signReleaseArtifact(message: Buffer): string {
  const raw = process.env[RELEASE_SIGNING_KEY_ENV];
  if (!raw || !raw.trim()) return ''; // 未配置 → 关闭签名，保持现有行为

  const secretKeyText = resolveSecretKeyText(raw.trim());
  const { keynum, seed, pk } = parseMinisignSecretKey(secretKeyText);

  // 由 seed(d) + pk(x) 重建 Ed25519 私钥（两者均取自 minisign 私钥体，天然成对的合法密钥）。
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: seed.toString('base64url'), x: pk.toString('base64url') },
    format: 'jwk',
  });

  // 预哈希（minisign 默认）：主签名 = Ed25519( BLAKE2b-512(message) )。
  const prehash = createHash('blake2b512').update(message).digest();
  const mainSig = sign(null, prehash, key);
  if (mainSig.length !== 64) throw new Error('发布者签名失败：主签名长度异常');

  // 可信注释（任意文本，被纳入全局签名以防篡改）。桌面侧校验时剥离 "trusted comment: " 前缀(17 字节)。
  const trustedPayload = `lingfang ${Date.now()}`;
  const trustedCommentLine = `trusted comment: ${trustedPayload}`;
  // 全局签名 = Ed25519( 主签名(64) ‖ 可信注释载荷(前缀之后的字节) )。
  const globalSig = sign(null, Buffer.concat([mainSig, Buffer.from(trustedPayload, 'utf8')]), key);
  if (globalSig.length !== 64) throw new Error('发布者签名失败：全局签名长度异常');

  // bin1 = 算法(2)=0x45 0x44 + keyId(8) + 主签名(64) = 74 字节。
  const bin1 = Buffer.concat([Buffer.from([0x45, 0x44]), keynum, mainSig]);
  return (
    [
      'untrusted comment: lingfang release artifact signature',
      bin1.toString('base64'),
      trustedCommentLine,
      globalSig.toString('base64'),
    ].join('\n') + '\n'
  );
}

/** env 值可能是私钥文件路径，也可能是私钥文本本身——自动判别。 */
function resolveSecretKeyText(value: string): string {
  if (existsSync(value)) {
    try {
      return readFileSync(value, 'utf8');
    } catch (e) {
      throw new Error(`读取发布者私钥文件失败：${(e as Error).message}`);
    }
  }
  return value;
}

/** 解析 minisign 私钥文件文本，取出 keynum / seed / pk。 */
function parseMinisignSecretKey(text: string): { keynum: Buffer; seed: Buffer; pk: Buffer } {
  // 文本两行：第 1 行 "untrusted comment: ..."，第 2 行 base64（可含末尾 \n）。
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const b64Line = lines.find((l) => l.length > 0 && !l.startsWith('untrusted comment:'));
  if (!b64Line) throw new Error('发布者私钥格式非法：缺少 base64 私钥行');
  let decoded: Buffer;
  try {
    decoded = Buffer.from(b64Line, 'base64');
  } catch (e) {
    throw new Error(`发布者私钥 base64 解码失败：${(e as Error).message}`);
  }
  // 标准 minisign 私钥体 = keynum(8) + libsodium_sk(64) = 72 字节；个别工具额外带 pk(32)=104。
  if (decoded.length !== 72 && decoded.length !== 104) {
    throw new Error(`发布者私钥长度异常（期望 72 或 104 字节，实际 ${decoded.length}）`);
  }
  const keynum = decoded.subarray(0, 8);
  const sk = decoded.subarray(8, 8 + 64); // libsodium crypto_sign 私钥：seed(32)+pk(32)
  const seed = sk.subarray(0, 32);
  const pk = sk.subarray(32, 64);
  return { keynum, seed, pk };
}

/** 是否已配置发布者签名密钥（供调用方决定是否把 signature 纳入响应/审计）。 */
export function isReleaseSigningEnabled(): boolean {
  const raw = process.env[RELEASE_SIGNING_KEY_ENV];
  return !!raw && raw.trim().length > 0;
}
