# 桌面端更新系统集成（自制更新器）

> 2026-07-31 重写。旧版本文档描述的是 `tauri-plugin-updater` + minisign 验签方案，**已整体删除**。
> 现状是自制更新器：后端登记安装包 SHA-256，桌面端下载后比对校验完整性，再调起 installer 二进制的
> `update` 模式覆盖重启。本文与代码（`update.rs` / `updater.ts` / `installer/`）保持一致。
>
> 2026-08-07 增补：**发布者 minisign 签名回归**（env-gated，商业就绪 P1）。注意与旧方案的本质区别：
> 旧方案是 tauri-plugin-updater 内嵌 pubkey 的插件式验签；新方案是自制更新器 + 后端上传时签名
> （`release-signing.ts`）+ 桌面 `LINGFANG_UPDATER_PUBKEY` 环境变量门控验签（fail-closed）。
> 仍**不依赖 tauri-plugin-updater**。

## 概述

「检查更新 → 下载 → 校验 SHA-256 → （配置公钥时）minisign 验签 → 覆盖安装 → 重启」全链路自制，**不依赖 tauri-plugin-updater**。
完整性用后端上传安装包时计算的 SHA-256（`ReleaseAsset.sha256`），桌面端下载后流式比对。
真实性（防伪造安装包）由发布者 minisign 签名保证：后端配置 `LINGFANG_RELEASE_SIGNING_KEY` 时上传即签名写入
`ReleaseAsset.signature`，桌面配置 `LINGFANG_UPDATER_PUBKEY` 后强制验签；两者均未配置时退化为仅 SHA-256（向后兼容）。

更新源指向用户动态配置的协作后端（`lf:backendUrl`）`/api/releases/latest`，不写死任何 endpoint。

## 架构总览

```
后端 collab-api（release 模块）
  POST /api/admin/releases/:id/assets/upload  → 落盘 downloads/ + createHash 算 sha256 入库
                                              + （配置 LINGFANG_RELEASE_SIGNING_KEY 时）minisign 签名写 signature
  GET  /api/releases/latest?channel&platform&arch&currentVersion
       → { version, notes, updateAvailable, assets:[{platform,arch,url,sha256,signature,sizeBytes}] }
        │ 桌面端检查更新
        ▼
桌面主程序 lingfang-desktop.exe（src-tauri/src/update.rs）
  check_update    GET /latest → 挑匹配 platform/arch 的 asset → UpdateMetadata（含 downloadUrl/sha256/signature）
  download_update 流式下载 EXE → 流式 SHA-256 比对 → （配置 LINGFANG_UPDATER_PUBKEY 时）minisign 验签
                  → 复制安装目录 updater.exe 到临时目录
                  → 启动它 `update --target --setup --wait-pid --restart` → app.exit(0)
        ▼
updater.exe（= installer.exe 的 update 子命令，installer/src/modes/mod.rs run_update）
  等主进程 pid 退出（≤30s）→ 静默运行新版 Setup `--silent --target`（自解压覆盖）→ 重启主程序 → 计划自删除
```

## 后端契约（release.service.ts）

- `GET /api/releases/latest`（@Public，无鉴权）：
  - 入参 `channel`（STABLE/BETA，默认 STABLE）、`platform`、`arch`、`currentVersion`。
  - 取同 channel 内 `isLatest=true && status=PUBLISHED` 的版本；无则 **404 `release_not_found`**（桌面端视为无更新）。
  - `updateAvailable`：仅当传了 `currentVersion` 时返回，`isNewer(latest, current)`（轻量 semver 比较，主.次.修数值 + prerelease 规则）。
  - `assets` 按 platform/arch 过滤后出参含 `url`（可为 `/downloads/xxx` 相对路径）、`sha256`、`sizeBytes`。
- `POST /api/admin/releases/:id/assets/upload`（平台 Admin）：
  - 文件名加随机前缀防冲突，落 `downloads/`；`url` 存相对路径 `/downloads/<name>`。
  - **上传即 `createHash('sha256')` 计算哈希入库**（buffer 模式 hash 内存，diskStorage 模式读落盘文件）。hash 失败不阻断上传（sha256 留空，但桌面端会因校验值缺失拒绝该 asset）。
  - **发布者签名（env-gated）**：配置 `LINGFANG_RELEASE_SIGNING_KEY` 时用 minisign 私钥对同一份安装包字节签名，
    产出标准 `.minisig` 4 行文本写入 `ReleaseAsset.signature`（`release-signing.ts::signReleaseArtifact`）。
    密钥已配置但签名失败 → 抛 500 `release_sign_failed`（fail-closed，绝不静默下发未签名包）。未配置密钥 → signature 恒空。
- `signature` 字段随 `/api/releases/latest` 的 asset 一并下发（未配置签名密钥时恒空）。桌面端配置公钥后对其强制验签。

### 签名格式契约（release-signing.ts ↔ minisign-verify 0.2，勿改）

后端 Node 侧手写的 minisign 签名必须与桌面 Rust 侧 `minisign-verify` crate 的 `Signature::decode` + `PublicKey::verify` 逐字节兼容：

- 4 行文本：`untrusted comment: …` / base64(bin1，**74 字节**) / `trusted comment: …` / base64(全局签名，**64 字节**)。
- bin1 = 算法字节 `0x45 0x44`（"ED"= 预哈希模式）+ keyId(8) + 主签名(64)。
- 主签名 = `Ed25519(BLAKE2b-512(message))`（minisign 预哈希默认）；桌面 `verify(.., allow_legacy=false)` 仅接受预哈希签名。
- 全局签名 = `Ed25519(主签名(64) ‖ 可信注释载荷)`（"trusted comment: " 前缀 17 字节之后的部分）。
- 私钥体 72 字节 = keynum(8) + libsodium_sk(seed(32)+pk(32))；Ed25519 私钥经 JWK `{d:seed, x:pk}` 重建。
- 兼容性由 `release-signing.spec.ts` 用 Node 复刻 crate 验签逻辑做 round-trip 锁定；改签名结构前先跑它。

## 桌面端 Rust 契约（update.rs）

### check_update

```rust
#[tauri::command]
pub async fn check_update(app, channel: String, backend_url: String)
    -> Result<Option<UpdateMetadata>, String>
```

- 拼 `<backend>/api/releases/latest?channel=&platform=&arch=&currentVersion=`（`build_latest_url`，纯函数可单测）。
- platform/arch 由 `std::env::consts::{OS,ARCH}` 映射：windows→WINDOWS、macos→DARWIN、linux→LINUX；x86_64→X86_64、aarch64→AARCH64。
- HTTP 404 → `Ok(None)`（无已发布版本）；其他非 2xx → `Err`（暴露给前端）。
- `updateAvailable != Some(true)` → `Ok(None)`；否则挑匹配 platform/arch 的 asset 构造 `UpdateMetadata`。
- `UpdateMetadata`（serde camelCase）：`version / currentVersion / available / notes / downloadUrl / sha256 / signature / sizeBytes`。
  `downloadUrl` 经 `absolute_url` 把相对路径拼成绝对地址；`signature` 为发布者 minisign 签名（.minisig 全文，serde default 空串）。

### download_update

```rust
#[tauri::command]
pub async fn download_update(app, meta: UpdateMetadataInput, on_event: Channel<DownloadEvent>)
    -> Result<(), String>
```

- `meta.sha256` 为空 → 直接拒绝（`该版本缺少 SHA-256 校验值…`）。
- **下载地址安全校验（fail-closed）**：`is_safe_download_url` 强制 https 协议 + 拒绝环回/私网/链路本地/云元数据等保留地址
  （域名做 DNS 解析后逐一检查，解析失败也拦截），防响应劫持换包与 SSRF。
- **发布者签名验签（env-gated，fail-closed）**：SHA-256 校验通过后，
  - 配置 `LINGFANG_UPDATER_PUBKEY`：`meta.signature` 为空 → 拒绝；否则 `minisign-verify` 验签（预哈希 "ED" 模式，
    `verify(bytes, sig, allow_legacy=false)`），失败即删包拒绝。
  - 未配置：仅 SHA-256，stderr 输出明确告警（非静默降级）。
- **超时策略**：`connect_timeout(30s)` + `read_timeout(120s)`，**不用全局 timeout**。
  500MB+ 安装包在慢网下「慢但持续」下载时，全局 timeout（旧实现 600s）会把整段响应体超时误杀；
  `read_timeout` 只限单次读（每 chunk），建连慢/中途断流才会失败。
- **临时文件清理**：
  - 开始前 `clean_stale_setups` 清扫临时目录历史残留 `LingFang-Setup-*.exe`（历次失败/中断会累积占盘）。
  - 下载失败（建连/HTTP/读 chunk/写盘）与 SHA-256 不匹配 / 读文件失败 → 统一 `remove_file` 半截文件再返回 Err。
- 下载经 `download_to_file` helper 流式写盘，经 `Channel<DownloadEvent>` 推 Started（首 chunk，带 contentLength）/ Progress（每 chunk 的 chunkLength）/ Finished。
- SHA-256 用 `sha256_hex` 流式计算（64KB 缓冲），与 `meta.sha256` 忽略大小写比对。
- 校验通过 → 定位安装目录（`current_exe().parent()`）→ 缺 `updater.exe` 报错引导手动覆盖安装 →
  复制 `updater.exe` 到临时目录（`lingfang-updater-<pid>.exe`，避免覆盖时占用自身）→
  `spawn` 它 `update --target <安装目录> --setup <下载的EXE> --wait-pid <pid> --restart` → `app.exit(0)`。
- **成功路径进程退出，Promise 不会 resolve**；失败路径 reject，主程序仍可用（前端解锁 Dialog 可重试）。

### DownloadEvent serde 契约（前后端一致，勿改）

```rust
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}
```

- `#[serde(rename_all="camelCase")]` 标在 enum 顶层只 rename 变体名，**不 rename 变体内部字段**——
  要让字段 camelCase（contentLength/chunkLength），**每个变体单独标**。
- 结果：event 是 PascalCase（Started/Progress/Finished），字段 camelCase。

## installer 二进制（apps/desktop/installer）

三合一：`install`（egui 交互）/ `--silent --target`（无 UI 覆盖）/ `update`（等待+覆盖+重启）/ `uninstall`（egui 确认）。

- 自解压格式（`sfx.rs`）：`[installer.exe PE 字节][payload.zip][trailer]`，trailer = `MAGIC(8="LFSFX\0\0\0") + payload_len(u32 LE)`。
  无 trailer/MAGIC 不匹配 → 裸 installer（updater 副本/dev 直跑），update/uninstall 不需要 payload。
- `update` 模式（`modes/mod.rs::run_update`）：等 `wait_pid` 退出（`platform::wait_for_pid`，≤30s，超时仍继续）→
  运行新版 setup `--silent --target <dir>`（非零退出码报错）→ 删临时 setup → 可选重启 `MAIN_EXE` → `platform::schedule_self_delete` 自删除。
- 日志写 `%LOCALAPPDATA%\LingFang\logs\updater.log`（无 UI 模式排障）。
- 打包脚本 `tools/build-installer.ps1`：tauri build（嵌前端）→ cargo build installer → 收集 app 文件到 staging →
  Compress-Archive 成 payload.zip → 拼接 `[installer.exe][payload.zip][trailer]` → `LingFang-Setup-<ver>.exe`；
  产物里的 `updater.exe` = 干净 installer.exe（无 payload 尾部）。

## 前端契约（src/lib/updater.ts）

- `checkUpdate(backendUrl, channel)` → `Promise<UpdateMetadata | null>`（tauriInvoke `check_update`）。
- `downloadUpdate(meta, onEvent)` → 用 `@tauri-apps/api/core` 的 `Channel<DownloadEvent>` 订阅进度（tauriInvoke `download_update`）。
- 更新通道：`loadUpdateChannel/saveUpdateChannel`（localStorage `lf:update-channel`，STABLE/BETA）。
- **检查结果缓存**（更新可用提示增强）：`loadCachedUpdate/saveCachedUpdate/clearCachedUpdate`（localStorage `lf:cached-update`）。
  - `App.tsx` 启动静默检查：发现新版本 `saveCachedUpdate`，已是最新 `clearCachedUpdate`（网络失败不动缓存）。
  - `Settings.tsx` 挂载即 `loadCachedUpdate`，有缓存显示「发现新版本 vX（检查于 …）」横幅，可**直接更新无需重新检查**；
    手动检查发现新版本写缓存、无更新清缓存；进入安装流程清缓存。

## Settings 页更新 UX（Settings.tsx）

- 检查更新 Dialog：changelog（Markdown 渲染 notes）+ 进度条 + 立即更新。安装中锁定（阻外点/Esc/关闭）。
- **进度体验**：
  - 已知总大小：百分比 + 下载速度（`formatBytes(speed)/s`，自 Started 起的平均速度）+ 预计剩余（`formatDuration(eta)`）。
  - 未知总大小：不定进度动画（`.animate-indeterminate`，index.css 定义的左右滑动 keyframe），替代旧固定 36% 误导进度；右侧显示已下载字节数。
  - 下载失败：主按钮文案变「重试下载」（`updateMeta` 仍在，直接重新下载，无需重新检查）。
- 应用内「查看更新日志」（ChangelogDialog）走后端 `GET /api/changelog`（Gitee release 源），**不读仓库 CHANGELOG.md**；
  仓库根 `CHANGELOG.md` 是面向用户的发行说明文档（打包信息/SHA-256 记录于此）。

## 关键技术陷阱（实战）

1. **`app.exit(0)` 后 Promise 不 resolve**：download_update 成功路径进程退出，前端 await 永远 pending；前端用 Finished 事件 + 兜底 toast 处理。
2. **DownloadEvent 字段 camelCase 要每变体单独标 `rename_all`**（见上）。
3. **进度用 `ipc::Channel<T>` 不用 emit 事件**：类型安全，前端 `import { Channel } from '@tauri-apps/api/core'`。
4. **`generate_handler!` 要求命令返回类型 pub**：UpdateMetadata/DownloadEvent 本身要 `pub`。
5. **大文件下载别用全局 timeout**：用 connect_timeout + read_timeout（见 download_update）。
6. **updater.exe 须复制到临时目录再运行**：否则覆盖安装目录时会覆盖正在运行的自身。
7. **tauri.conf.json 顶层不能塞自定义字段**：`tauri-build` 严格校验，注入未知字段（如历史残留 `buildInfo`）会让 `tauri build` 直接失败。
   版本走 `app.package_info().version`；构建元信息 collab-api 用 `src/build-info.ts`，桌面端不写 tauri.conf.json。

## 平台映射

| Tauri OS | 后端 platform | Tauri ARCH | 后端 arch |
| -------- | ------------- | ---------- | --------- |
| windows  | WINDOWS       | x86_64     | X86_64    |
| macos    | DARWIN        | aarch64    | AARCH64   |
| linux    | LINUX         | x86_64     | X86_64    |

## 参考文件

- `apps/desktop/src-tauri/src/update.rs` — check_update / download_update / download_to_file / clean_stale_setups。
- `apps/desktop/src/lib/updater.ts` — 前端封装 + 更新通道 + 检查结果缓存。
- `apps/desktop/src/pages/Settings.tsx` — 检查更新 UI / 进度 / 缓存横幅。
- `apps/desktop/src/App.tsx` — 启动静默检查 + 缓存写入。
- `apps/desktop/installer/src/modes/mod.rs` — update 模式（等待+覆盖+重启）。
- `apps/collab-api/src/modules/release.service.ts` — latest / uploadAsset（sha256 + 签名门控）。
- `apps/collab-api/src/modules/release-signing.ts` — 后端 minisign 签名（env-gated，格式契约见上）。
- `tools/build-installer.ps1` — 自解压安装包打包。

## Scenario: 检查更新端到端

- 启动：App.tsx 静默 `checkUpdate` → 有更新写缓存 + toast 引导去设置页；无更新清缓存。
- 设置页：挂载读缓存显示横幅；或点「检查更新」→ `check_update` → 有更新弹 Dialog（version + notes）。
- 立即更新：`download_update` → Channel 推 Started/Progress/Finished（速度/ETA/不定进度）→ SHA-256 校验 →
  调起 updater.exe → app.exit → updater 等待+静默覆盖+重启。失败 → toast + 「重试下载」。

### Wrong vs Correct

- Wrong：用 tauri-plugin-updater；endpoints 写死 conf.json；全局 timeout 下载大文件；
  DownloadEvent 字段没 camelCase；tauri.conf.json 塞 buildInfo；下载失败留半截临时文件；
  更新下载放行 http/内网地址；配置了公钥却允许无签名更新。
- Correct：自制更新器 + SHA-256（完整性）+ env-gated minisign 发布者签名（真实性，fail-closed）；
  endpoint 运行时拼接；下载仅 https + 拒保留地址；connect/read timeout；每变体单独 rename；
  版本走 package_info；失败统一清理临时文件 + 前端可重试。
