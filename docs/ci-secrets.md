# CI / 发布签名密钥与 Secret 管理（P1-8 三件套）

桌面端更新验签采用「编译期内嵌公钥 + CI 私钥签名 + 后端上报」三件套（见
`apps/desktop/src-tauri/src/update.rs` 的 `UPDATER_PUBKEY` 与
`verify_update_signature`，以及 `apps/collab-api` 的 `POST /api/admin/release-signature`）。

本文件登记所有相关 CI Secret / Variable 的含义、来源与轮换方式。**任何 secret 都不得提交进仓库。**

## Secret / Variable 清单

| 名称 | 类型 | 用途 | 来源 |
| --- | --- | --- | --- |
| `MINISIGN_KEY` | Secret | minisign 私钥全文（`.minisign` 私钥文件两行文本） | `minisign -G` 生成，仅存 CI |
| `MINISIGN_PASSWORD` | Secret | 上述私钥的口令（若生成时设了口令） | 团队口令库 |
| `MINISIGN_SHA256` | Variable | `minisign-0.11-linux.tar.gz` 的 SHA-256，供 `desktop-sign.yml` 校验 | 官方 release 校验和 |
| `BACKEND_API` | Secret | 后端基地址，如 `https://api.lingfang.example` | 部署文档 |
| `BACKEND_TOKEN` | Secret | 平台管理员令牌（需 `platform.release.manage` 权限） | 管理员账号生成 |

> `UPDATER_PUBKEY` **不是** CI Secret，而是编译期内嵌在 `update.rs` 的常量（公钥 base64 公钥行去掉
> `untrusted comment:` 前缀后的 42 字节 base64）。它必须与 `MINISIGN_KEY` 对应，否则桌面会拒绝所有更新。

## 公钥与私钥的关系

- `minisign -G` 同时产出 `minisign.key`（私钥）与 `minisign.pub`（公钥）。
- `minisign.pub` 内容为两行：`untrusted comment: ...` + base64( `0x45 0x44` ‖ keynum(8) ‖ ed25519_pub(32) )。
- 取第二行 base64 字符串，写入 `update.rs` 的 `UPDATER_PUBKEY`。
- `MINISIGN_KEY` = `minisign.key` 全文（含其第一行 untrusted comment）。

## 轮换流程（密钥泄露或定期轮换）

1. 生成新 keypair：`minisign -G`（记录新 `minisign.pub` / `minisign.key`）。
2. 更新 CI Secret `MINISIGN_KEY` 为新私钥全文。
3. 更新 `update.rs` 的 `UPDATER_PUBKEY` 为新公钥第二行 base64，重新编译并发布桌面壳。
4. 旧安装包仍用旧签名：旧客户端内嵌旧公钥，可继续验旧签名；新客户端用新公钥。
   **注意**：公钥更换后，用旧私钥签的新包会被新客户端拒绝——因此先发新版客户端、再签新包。

## 降级防护边界

- 桌面验签为 fail-closed：缺签名 / 签名非法 / 公钥不配对 → 更新被拒（见 `update.rs` 三件套测试）。
- `desktop-sign.yml` 下载 minisign 时校验 `MINISIGN_SHA256`，未配置则 fail-closed 拒绝安装。
- 后端 `POST /api/admin/release-signature` 要求平台管理员权限，非管理员上报被拒（403）。
