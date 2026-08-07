# 签名格式兼容性核验：release-signing.ts ↔ minisign-verify 0.2.5

日期：2026-08-07 · 方法：逐字段比对 `apps/collab-api/src/modules/release-signing.ts` 产出格式与
`.cargo-home/registry/src/index.crates.io-*/minisign-verify-0.2.5/src/lib.rs` 的 `Signature::decode` + `PublicKey::verify`。

## 结论：完全兼容 ✅

### 1. 签名文本结构（Signature::decode，lib.rs:232-268）

| crate 要求                                       | release-signing.ts 产出                                  | 匹配 |
| ------------------------------------------------ | -------------------------------------------------------- | ---- |
| 第 1 行 untrusted comment（任意文本）            | `untrusted comment: lingfang release artifact signature` | ✅   |
| 第 2 行 base64(bin1)，bin1 必须 74 字节          | `[0x45,0x44]`(2) + keynum(8) + mainSig(64) = 74          | ✅   |
| 第 3 行必须以 `trusted comment: `（17 字符）开头 | `trusted comment: lingfang <ts>`                         | ✅   |
| 第 4 行 base64(bin2)，bin2 必须 64 字节          | globalSig(64)                                            | ✅   |

### 2. 算法字节与验签模式（lib.rs:255-259, 351-371）

- `(0x45, 0x44)` = "ED" → `is_prehashed = true`。crate 在 verify 内自行对原文做 BLAKE2b-512 再验 Ed25519。
- `update.rs:118` 调 `pubkey.verify(message, &signature, false)`：第 3 参是 **allow_legacy**（不是 prehashed）——
  预哈希签名自动走 hash 分支，`false` 仅表示拒绝旧式 "Ed" 裸签名。后端产出恒为 "ED"，匹配。✅
- release-signing.ts:32 注释"verify(.., false) 仅接受预哈希签名"表述准确。

### 3. 密码学原语

| 项         | crate                                                                | release-signing.ts                                                                      | 匹配 |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---- |
| 主签名     | Ed25519(BLAKE2b-512(msg))（lib.rs:361-364 + verify_ed25519）         | `sign(null, createHash('blake2b512').update(msg).digest(), key)`                        | ✅   |
| 全局签名   | Ed25519(mainSig ‖ trusted_comment[17..])（lib.rs:338-342）           | `sign(null, mainSig ‖ trustedPayload)`，trustedPayload = 前缀之后部分                   | ✅   |
| keyId 校验 | pubkey.key_id == sig.key_id（lib.rs:357）                            | keynum 取自私钥体前 8 字节，与公钥文件 key_id 同源（minisign 生成时成对）               | ✅   |
| 公钥结构   | from_base64：42 字节 = sigalg(2)+key_id(8)+key(32)（lib.rs:289-310） | 部署侧由 minisign -G 生成公钥行，LINGFANG_UPDATER_PUBKEY 直接放 base64 行即可           | ✅   |
| 私钥结构   | —（crate 只验签）                                                    | 72 字节体 keynum(8)+seed(32)+pk(32)，JWK {d:seed, x:pk} 重建 Ed25519；兼容 104 字节变体 | ✅   |

### 4. 桌面侧 fail-closed 链路（update.rs）

- 配置 `LINGFANG_UPDATER_PUBKEY`：signature 为空 → 拒绝（:354-360）；验签失败 → 拒绝（:363-366）。
- 未配置：仅 SHA-256 + stderr 告警（:368-372）。
- 前端 `updater.ts` UpdateMetadata.signature 可选字段透传，`UpdateMetadataInput.signature` serde default。✅

### 5. 既有测试

- `release-signing.spec.ts`：Node 复刻 crate decode+verify 做 round-trip（真 Ed25519 密钥），覆盖未配置返回 ''。✅
- 缺口：`release.service.spec.ts` 未覆盖 uploadAsset 的签名开关两路径；`admin-users.service.spec.ts` 不存在（密码校验无测试）。→ 本任务补齐。

### 部署注意（交给运营侧）

- 后端 env `LINGFANG_RELEASE_SIGNING_KEY` = minisign 私钥（.minisign 文件全文或路径）。
- 桌面端 env `LINGFANG_UPDATER_PUBKEY` = minisign 公钥 base64 行（42 字节结构）。
- 两者必须是同一对密钥；私钥丢失 = 已配公钥的客户端永远无法更新（fail-closed）。
