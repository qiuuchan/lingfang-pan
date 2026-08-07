# 安全政策 (Security Policy)

## 支持的版本

| 版本       | 是否安全维护 |
| ---------- | ------------ |
| `main`     | ✅ 是        |

请基于 `main` 分支报告问题；我们仅在 `main` 上修复安全漏洞。

## 报告漏洞

如果你发现安全漏洞，**请勿公开披露**。请通过以下方式 privately 报告：

- 首选：在 GitHub 仓库的 **Security → Report a vulnerability**（Private
  vulnerability reporting）提交。这是唯一不会公开可见的仓库内渠道——
  普通 Issue 即便在私有仓库里，对所有协作者也都是可见的，不要用它报漏洞。
- 若该入口未开启：联系仓库 Owner（GitHub 个人主页上的联系方式）。

我们会在 **72 小时内** 确认收到，并在确认后给出修复与披露时间表。

## 供应链安全

本项目对分发包实施了供应链签名：

- 后端在发布资源（安装包等）时，使用 **minisign (Ed25519/BLAKE2b)** 对字节生成签名：
  `apps/collab-api/src/modules/release-signing.ts`。
- 桌面端在下载更新前校验签名：`apps/desktop/src-tauri/src/update.rs`，
  公钥通过环境变量 `LINGFANG_UPDATER_PUBKEY` 注入；未配置公钥时回退到 SHA-256 完整性校验。
- 生产环境应始终配置 `LINGFANG_RELEASE_SIGNING_KEY`（后端签名）与 `LINGFANG_UPDATER_PUBKEY`（桌面端验签），
  并保管好私钥，禁止入仓（`.gitignore` 已忽略 `*.key` / `.tauri/`）。

## 已知已修复的安全项

- **默认管理员密码**：后端 `admin-users.service.ts` 已移除硬编码默认密码，
  创建管理员时强制要求初始密码非空且长度 ≥ 8 位。
