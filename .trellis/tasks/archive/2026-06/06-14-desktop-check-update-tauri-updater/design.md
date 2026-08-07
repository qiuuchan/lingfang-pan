# 技术设计：桌面端检查更新（Tauri updater 集成）

> 配套 `prd.md`。Tauri 2 updater 知识来自 context7 `/tauri-apps/tauri-docs` 官方文档（非训练记忆）。

## 1. Tauri updater 契约（关键约束）

Tauri updater 期望 endpoint（`endpoints` 配置的 URL）返回**固定 JSON 结构**：

```json
{
  "version": "1.0.0",
  "pub_date": "2026-06-14T12:00:06.843Z",
  "url": "https://.../LingFang_1.0.0_x64-setup.exe",
  "signature": "dW50cnVzdGVk...", // base64 签名（Tauri minisign 格式）
  "notes": "## changelog..."
}
```

- **HTTP 200 + 此结构** → 有更新，updater 下载 url 指向的包，用 pubkey 验 signature，安装。
- **非 200（如 204 No Content）** → 无更新。
- `{{target}}`/`{{arch}}`/`{{current_version}}` 是 URL 模板占位符，updater 自动替换。

当前 `/api/releases/latest` 返回的是**业务结构**（assets 数组 + 多字段），不能直接喂给 updater。→ 需新增契约适配端点（R3）。

## 2. 数据流

```
前端「检查更新」按钮
  → tauriInvoke('check_update', {channel:'STABLE', backendUrl})
  → Rust updater.rs:
      url = {backendUrl}/api/releases/tauri-update?channel=STABLE&platform={os}&arch={arch}&current_version={app.version}
      app.updater_builder().endpoints([url]).build()?.check().await
      → 后端 GET /api/releases/tauri-update:
          releaseService.latest({channel, platform, arch}) → 挑单 asset
          → {version, pub_date, url, signature, notes}（Tauri 契约）
          无版本/无 asset → 204
      → updater 拿到 200 + 契约 JSON → 内部比对 version（或 204 判无更新）
      → 返回 {available, version, notes} 给前端
  → 有更新: Dialog 显示 version + notes(markdown)
  → 「立即更新」: tauriInvoke('download_and_install')
      → update.download_and_install(on_progress) + app.restart()
      → 进度经 emit updater://progress 给前端进度条
```

## 3. 后端端点（新 `/api/releases/tauri-update`）

`release.controller.ts` 追加（@Public）：

```ts
@Get('tauri-update')
@Public()
@ApiOperation({ summary: 'Tauri updater 契约端点（单 asset，无更新返 204）' })
async tauruUpdate(@Req() req: Request, @Res() res: Response) {
  // query: channel? platform? arch? current_version?
  // 复用 releaseService.latest()，挑 platform/arch 匹配的 asset，映射 Tauri 契约。
  // 无已发布版本 / 无匹配 asset → res.status(204).send()（Tauri 判无更新）。
}
```

`release.service.ts` 追加 `tauriManifest(channel, platform, arch)`：

- 复用 `latest()` 的查询逻辑（isLatest + PUBLISHED）。
- 挑 `assets.find(a => a.platform===platform && a.arch===arch)`。
- 返回 `{version, pub_date: publishedAt, url: asset.url, signature: asset.signature, notes}` 或 null。

**平台映射**（Tauri → 后端枚举）：

| Tauri target         | 后端 platform | 后端 arch |
| -------------------- | ------------- | --------- |
| `windows` + `x86_64` | WINDOWS       | X86_64    |
| `darwin` + `aarch64` | DARWIN        | AARCH64   |
| `darwin` + `x86_64`  | DARWIN        | X86_64    |
| `linux` + `x86_64`   | LINUX         | X86_64    |

Rust 侧从 `std::env::consts::{OS, ARCH}` 取，映射成后端枚举值拼进 URL query。

## 4. 桌面 Rust（新 `updater.rs`）

### 4.1 Cargo.toml

```toml
tauri-plugin-updater = "2"
```

### 4.2 tauri.conf.json

```json
{
  "bundle": {
    "createUpdaterArtifacts": true,
    "resources": { "../builtin-plugins": "builtin-plugins" }
  },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI0NDI2MjgyQ0U4MjE0RjcKUldUM0ZJTE9nbUpDSkcxMUoybjJtQm0xTzZVQm1FMFJFbmFqUWFTUlFYbGRSV2xFWVlMTGZMcUEK",
      "endpoints": [] // 空数组：不写死，运行时 updater_builder().endpoints() 动态注入
    }
  }
}
```

> endpoints 留空数组（必须有这个 key 插件才初始化），真实 URL 由 Rust 命令运行时注入。pubkey 是已生成的公钥（`.tauri/lingfang.key.pub` 内容）。

### 4.3 main.rs

```rust
mod updater;
// setup 或 builder:
.plugin(tauri_plugin_updater::Builder::new().build())
// invoke_handler 追加：updater::check_update, updater::download_and_install
```

### 4.4 updater.rs 命令（采用官方 PendingUpdate + Channel 模式）

```rust
use std::sync::Mutex;
use tauri::{ipc::Channel, State};
use tauri_plugin_updater::{Update, UpdaterExt};

// 官方推荐：State 存 check 拿到的 Update，install 时 take（check 与 install 分离）。
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMetadata { version: String, current_version: String, available: bool, notes: Option<String> }

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle, pending: State<'_, PendingUpdate>,
    channel: String, backend_url: String) -> Result<Option<UpdateMetadata>, String> {
    let (platform, arch) = current_platform();
    let app_version = app.package_info().version.to_string();
    let url = url::Url::parse(&format!(
        "{}/api/releases/tauri-update?channel={}&platform={}&arch={}&current_version={}",
        backend_url.trim_end_matches('/'), channel, platform, arch, app_version))
        .map_err(|e| e.to_string())?;
    let update = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?
        .build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let meta = update.as_ref().map(|u| UpdateMetadata {
        version: u.version.clone(), current_version: u.current_version.clone(),
        available: true, notes: u.body.clone(),
    });
    *pending.0.lock().unwrap() = update;  // 存起来供 install 用
    Ok(meta)
}

// 官方推荐：Channel 推进度（类型安全，比 emit 事件优）。
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum DownloadEvent {
    Started { contentLength: Option<u64> },
    Progress { chunkLength: usize },
    Finished,
}

#[tauri::command]
pub async fn download_and_install(pending: State<'_, PendingUpdate>, on_event: Channel<DownloadEvent>, app: tauri::AppHandle) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take()
        .ok_or("没有待安装的更新，请先检查更新".to_string())?;
    update.download_and_install(
        |chunk_length, content_length| {
            let _ = on_event.send(DownloadEvent::Progress { chunkLength: chunk_length });
            if let Some(_) = content_length { /* 首次 send Started */ }
        },
        || { let _ = on_event.send(DownloadEvent::Finished); },
    ).await.map_err(|e| e.to_string())?;
    app.restart();
    Ok(())
}
```

`current_platform()`：

```rust
fn current_platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "windows" => "WINDOWS", "macos" => "DARWIN", "linux" => "LINUX", o => o,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "X86_64", "aarch64" => "AARCH64", a => a,
    };
    (os, arch)
}
```

main.rs setup 注册 `app.manage(PendingUpdate(Mutex::new(None)))`。

### 4.5 Cargo.toml 追加依赖

```toml
tauri-plugin-updater = "2"
url = "2"   # url::Url::parse 用（若未引入）
```

（`url` crate 若 Cargo.toml 未有则加；若用 format! 拼 URL 不 parse 则不需要 url crate，可省略——优先用 format! 避免新依赖。）

## 5. 前端 UI（Settings.tsx）

- Tab3 后端服务 Card 下方加「检查更新」Card：
  - LoadingButton「检查更新」→ `tauriInvoke('check_update', {channel:'STABLE', backendUrl})`。
  - loading 态 → spinner。
  - 结果：available=false → toast「当前已是最新版本（v{app_version}）」。
  - available=true → Dialog：标题「发现新版本 v{version}」+ notes（复用 `<Markdown>` 组件）+ 「立即更新」/「稍后」按钮。
- 「立即更新」→ `tauriInvoke('download_and_install')` → 监听 `updater://progress` 显示进度条 → 完成自动重启。
- backendUrl 为空 → toast「请先在上方配置后端地址」。
- 错误按 ApiError.message toast（无专用 ErrorCode，用通用错误）。

## 6. 签名验证（构建时）

构建带签名的安装包：

```bash
$env:TAURI_SIGNING_PRIVATE_KEY_PATH="O:\lingfang-platform\.tauri\lingfang.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm --filter desktop build   # tauri build
```

产物：`target/release/bundle/*/LingFang_*.msi` + `LingFang_*.msi.zip`（Tauri updater 实际下载这个） + `LingFang_*.msi.zip.sig`（签名）。

`.sig` 内容（base64 minisign）需上传到 release asset 的 `signature` 字段（替换 seed 的空值）才能让 updater 验签通过。

## 7. 验证策略

- 后端单测：`tauriManifest` 平台映射 + 无版本返 null + 契约字段名（version/pub_date/url/signature/notes）。
- Rust 单测：`current_platform()` 映射（cfg gate，跨平台跳过）。
- 手动：构建带签名包 → 补 seed signature → 桌面端检查更新 → Dialog → 下载 → 安装 → 重启（AC1-AC9）。

## 8. 风险

- **signature 为空导致验签失败**：seed 数据 signature 空，必须用真实构建的 `.sig` 内容替换 asset.signature（admin PATCH `/api/admin/releases/:id/assets`）才能端到端跑通。这是手动验证前提，已在 prd AC9/阶段4 标注。
- **endpoint 动态**：updater 默认读 conf.json endpoints，本项目后端地址动态，必须运行时注入（已用 `updater_builder().endpoints()` 解决）。
- **pubkey 与私钥配对**：构建时用的私钥必须与 conf.json pubkey 是同一对（已用刚生成的 `.tauri/lingfang.key` + `.pub` 配对）。
