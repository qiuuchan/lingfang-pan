# Tauri Updater 集成（检查更新）

> 2026-06-14 集成 tauri-plugin-updater 的关键约定。知识来自 context7 `/tauri-apps/tauri-docs` 官方文档 + 实战踩坑。

## 概述

桌面应用集成 Tauri updater 实现「检查更新 → 下载 → 验签 → 安装 → 重启」。更新源指向后端 `/api/releases/tauri-update`（release 模块），签名密钥本地管理。

## Tauri updater 契约（强制约束）

Tauri updater 期望 endpoint 返回**固定 JSON 结构**（字段名精确，不可改）：

```json
{
  "version": "1.0.0",
  "pub_date": "2026-06-14T12:00:06.843Z",
  "url": "https://.../LingFang_1.0.0_x64-setup.exe",
  "signature": "dW50cnVzdGVk...",
  "notes": "## changelog..."
}
```

- **`pub_date` 是下划线**（不是 camelCase `pubDate`）。
- **`url` 必须是绝对 URL**（如 `https://api.example.com/downloads/...`）。管理后台上传落库可保存 `/downloads/...` 相对路径，但 `/api/releases/tauri-update` 返回前必须按当前请求 base 转成绝对 URL，否则 Tauri updater 会报 `relative URL without a base`。
- **HTTP 200 + 此结构** → 有更新；**非 200（如 204 No Content）** → 无更新。
- `signature` 是 Tauri minisign 格式（base64），构建时由私钥签名，运行时用 pubkey 验签。**强制验签，不可跳过**。

## 签名密钥管理

- 密钥对：`.tauri/lingfang.key`（私钥）+ `.tauri/lingfang.key.pub`（公钥）。
- `.gitignore` 必须含 `.tauri/` + `*.key`（**私钥永不入仓**）。
- 公钥内嵌 `tauri.conf.json` 的 `plugins.updater.pubkey`（base64 整行）。
- 构建时设 `TAURI_SIGNING_PRIVATE_KEY`（**传私钥内容字符串，不是 `_PATH`**）+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（无密码则空串），产物自动签名（`.exe` + `.exe.sig`）。
  - **实战踩坑**：文档说 `TAURI_SIGNING_PRIVATE_KEY_PATH` 和 `TAURI_SIGNING_PRIVATE_KEY` 都支持，但实测 `_PATH` 不生效（报 `no private key`）。**必须用 `_KEY` 传值**：
    ```bash
    TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri/lingfang.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build --bundles nsis
    ```
- **pubkey 与私钥必须配对**：构建用的私钥 = conf.json pubkey 的配对密钥，否则验签失败。

## endpoint 动态注入（本项目特有）

本项目后端地址是用户在设置页动态配置的（`lf:backendUrl`），**不能写死 tauri.conf.json 的 endpoints**。

- `tauri.conf.json` 的 `plugins.updater.endpoints` 留 `[]`（必须有 key 插件才初始化）。
- Rust 命令运行时用 `app.updater_builder().endpoints(vec![url::Url]).build()?.check().await` 动态注入：
  ```rust
  let url = url::Url::parse(&format!(
      "{}/api/releases/tauri-update?channel={}&platform={}&arch={}&current_version={}",
      backend_url.trim_end_matches('/'), channel, platform, arch, app_version))?;
  app.updater_builder().endpoints(vec![url])?.build()?.check().await?
  ```
- **注意**：`endpoints()` 参数是 `Vec<url::Url>`（不是 `Vec<String>`），需 `url = "2"` crate + `Url::parse`。Cargo.toml 必须加 `url`。

## 官方推荐的 check/install 分离模式

不要 check 完丢弃 Update 对象。用 `State<PendingUpdate>` 缓存：

```rust
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[tauri::command]
async fn check_update(app, pending: State<'_, PendingUpdate>, ...) -> Result<Option<UpdateMetadata>, String> {
    let update = app.updater_builder()...check().await?;
    let meta = update.as_ref().map(|u| UpdateMetadata { version: u.version.clone(), ... });
    *pending.0.lock().unwrap() = update;  // move 进 State 供 install 用
    Ok(meta)
}

#[tauri::command]
async fn download_and_install(pending: State<'_, PendingUpdate>, on_event: Channel<DownloadEvent>, app) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("无待安装更新")?;
    update.download_and_install(on_chunk, on_complete).await?;
    app.restart();  // never type (!)，不写 Ok(())，让 ! 强转 Result
}
```

main.rs setup 必须 `app.manage(PendingUpdate(Mutex::new(None)))`。

## 关键技术陷阱（实战踩坑）

1. **`app.restart()` 返回 never type `!`**：不要写 `app.restart(); Ok(())`（unreachable warning）。直接 `app.restart()` 作为尾表达式，`!` 自动强转为 `Result<(), String>`。

2. **`endpoints(vec![...])` 要 `Vec<Url>` 不是 `Vec<String>`**：必须加 `url = "2"` crate + `Url::parse`。

3. **DownloadEvent serde rename**：`#[serde(rename_all="camelCase")]` 标在 enum 顶层只 rename 变体名（不 rename 变体内部字段）。要让字段 camelCase，**每个变体单独标**：
   ```rust
   #[derive(Clone, Serialize)]
   #[serde(tag = "event", content = "data")]
   enum DownloadEvent {
       #[serde(rename_all = "camelCase")]
       Started { content_length: Option<u64> },
       #[serde(rename_all = "camelCase")]
       Progress { chunk_length: usize },
       Finished,
   }
   ```
   结果：event 是 PascalCase（Started/Progress/Finished），字段 camelCase（contentLength/chunkLength），对齐 `@tauri-apps/plugin-updater` JS 端。

4. **`generate_handler!` 要求命令类型 pub**：命令返回类型（UpdateMetadata/DownloadEvent）即使字段私有，struct/enum 本身要 `pub`（宏展开的 `__cmd__*` 是 pub(crate)）。

5. **进度用 `ipc::Channel<T>` 不用 emit 事件**：Channel 类型安全，前端 `import { Channel } from '@tauri-apps/api/core'` 订阅。

6. **204 端点用 `@Res({ passthrough: true })` 不用裸 `@Res`**：Nest 全局 `ClassSerializerInterceptor` 与裸 `@Res` 冲突（handler 返回 Response 对象 → 拦截器序列化 → Node `ERR_INTERNAL_ASSERTION` 崩溃）。passthrough 模式只控状态码，return 数据走标准 pipeline。

## 平台映射

Rust `std::env::consts::{OS, ARCH}` → 后端 AssetPlatform/AssetArch 枚举：
| Tauri OS | 后端 platform | Tauri ARCH | 后端 arch |
|---|---|---|---|
| windows | WINDOWS | x86_64 | X86_64 |
| macos | DARWIN | aarch64 | AARCH64 |
| linux | LINUX | x86_64 | X86_64 |

## 参考文件

- `apps/desktop/src-tauri/src/updater.rs` — check_update/download_and_install 命令 + PendingUpdate。
- `apps/desktop/src-tauri/tauri.conf.json` — createUpdaterArtifacts + plugins.updater。
- `apps/collab-api/src/modules/release.service.ts` — `tauriManifest()` 契约适配。
- `apps/collab-api/src/modules/release.controller.ts` — `GET /api/releases/tauri-update`。

## Scenario: 检查更新端到端

- 用户设置页点「检查更新」→ check_update(backendUrl) → 后端 tauri-update 端点 → Tauri updater 拿契约 JSON + 验签。
- 返回 UpdateMetadata（有更新）或 null（无更新）。
- 有更新弹 Dialog（version + notes markdown）→ 「立即更新」→ download_and_install → Channel 推进度 → app.restart。

### Wrong vs Correct
- Wrong：endpoint 返业务结构（assets 数组）直接喂 updater；endpoints 写死 conf.json；裸 @Res 返 204；DownloadEvent 字段没 camelCase。
- Correct：tauri-update 适配契约；endpoints 运行时注入；@Res passthrough；每变体单独 rename。
