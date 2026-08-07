# Design: 移除内置运行时改为按需下载与统一Resolver

## 1. 模块边界

**Rust（`apps/desktop/src-tauri/src/`）**

| 模块                  | 性质                         | 职责                                                                                                                               |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `runtime_resolver.rs` | 重构自 `embedded_runtime.rs` | 统一解析 + env 注入；公开 API 签名不变                                                                                             |
| `runtime_config.rs`   | 新增                         | `RuntimeConfig` serde + 原子读写（复用 plugin_store 的 read_json/write_json 模式）                                                 |
| `runtime_download.rs` | 新增                         | 下载 / SHA256 / 解压 / 原子落盘 / 激活 / 进度 event / 重试                                                                         |
| `mirror_presets.rs`   | 新增                         | 预置 pip / npm 镜像源清单                                                                                                          |
| `plugin_script.rs`    | 改                           | `probe_script_runtime` 数据源换 resolver；新增 `probe_system_runtime`（仅信息展示，不参与执行）                                    |
| `plugin_runner.rs`    | 改（小）                     | `from_app` → `resolve`；验证 `bundled_pip_wheel_dir`（`:420`，依赖 `Lib/ensurepip/_bundled/pip-*.whl`）在 portable python 下仍命中 |
| `main.rs`             | 改                           | mod 声明 + `generate_handler!` 注册新命令                                                                                          |

**前端（`apps/desktop/src/`）**

| 模块                                                   | 性质                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `pages/settings/RuntimeEnvTab.tsx`                     | 重构自 `CliRuntimeTab.tsx`（保留 tab id `cli`）             |
| `components/runtime/RuntimeSetupGate.tsx`              | 新增，首启引导                                              |
| `components/runtime/DownloadProgress.tsx`              | 新增，订阅 Tauri event 进度条                               |
| `lib/runtime-config.ts`                                | 新增，封装运行时相关 Tauri 命令                             |
| `lib/cli-types.ts`                                     | 改，加 RuntimeStatus / DownloadProgress / MirrorConfig 类型 |
| `components/onboarding/{task-steps,TaskChecklist}.tsx` | 改第 1 步文案 + 完成判定                                    |

## 2. 数据结构（契约）

### RuntimeConfig（`runtime-config.json`，camelCase alias 兼容前端）

```rust
struct RuntimeConfig {
    user_specified_python: Option<String>,
    user_specified_node: Option<String>,
    app_managed_python: Option<ManagedEntry>,
    app_managed_node: Option<ManagedEntry>,
    mirrors: MirrorConfig,
    download_mirror_base: Option<String>, // python-build-standalone 加速源
}
struct ManagedEntry { version: String, dir: String, installed_at: String }
struct MirrorConfig { pip_id: String, pip_url: Option<String>, npm_id: String, npm_url: Option<String> }
```

### RuntimeSource / RuntimeResolver

```rust
enum RuntimeSource { AppManaged(PathBuf), UserSpecified(PathBuf) }  // 不再有 builtin

struct RuntimeResolver {
    python: Option<(PathBuf, RuntimeSource)>,  // (root, source)
    node:   Option<(PathBuf, RuntimeSource)>,
    config: RuntimeConfig,
}
```

### ProbeResult 扩展

现有 `{ available, binary_path, version, hint }` 增加 `source: Option<RuntimeSource>` 和 `meets_minimum: bool`（semver 比对门槛）。

## 3. 解析优先级与「唯一来源」不变式

`resolve(kind)` 顺序，**严格按 config，不回退系统 PATH**：

1. `config.user_specified[kind]` → 校验 exe 存在 → `UserSpecified`；路径失效则该项作废、标异常
2. `config.app_managed[kind]` → 校验 exe 存在 → `AppManaged`
3. 都没有 → `None`；`require_*` 返回结构化错误 `RuntimeMissing { kind }`，前端引导下载

**三条不变式**（保证「Agent 一定用应用内的」）：

1. `resolve_runtime_command()` 永不 `which`/PATH 搜索，只查 AppManaged/UserSpecified
2. `env()` 清空宿主 PATH（现状已做 `embedded_runtime.rs:127`），只注入命中来源的 PATH —— 子进程内部 `subprocess.run("python")` 也只能命中应用管理的解释器
3. 找不到返回 `RuntimeMissing` 错误，前端引导，不静默回退

## 4. 数据流

**下载激活流**：UI `downloadRuntime(kind)` → `download_runtime` 命令 → `runtime_download`（下载→SHA256→解压→staging→rename 原子落盘）→ 写 config `app_managed_*` → emit 进度 event → resolver 下次命中

**执行流**（不变）：插件运行 → `plugin_runner` → `resolver.resolve()` → `require_runtime_command("python")` → spawn

**镜像注入流**：设置页选源 → `set_mirror_config` → 写 config → 子进程启动时 `resolver.env()` 读 config 注入 `PIP_INDEX_URL` / `NPM_CONFIG_REGISTRY`

## 5. 下载源

- **Node**：主源 `https://nodejs.org/dist/v{ver}/node-v{ver}-win-x64.zip`；加速 `https://registry.npmmirror.com/-/binary/node/v{ver}/...`（npmmirror 稳定镜像）。SHA256 拉同目录 `SHASUMS256.txt`。
- **Python**：`python-build-standalone` GitHub releases（`install_only` 变体）。国内裸拉 GitHub 大概率超时——config `download_mirror_base` 可配（默认 GitHub），下载器内置多候选源依次尝试（GitHub → gh-proxy 类）。**最大体验风险**。
- 解压用 `zip` + `flate2` + `tar` crate（不依赖系统工具，保证可移植）；同卷 rename 原子落盘。

## 6. 打包改动

- `tools/build-installer.ps1:67` 删除 runtimes 复制行（保留 `:68` builtin-plugins）
- `tauri.conf.json:17-20` `resources` 删 `"../runtimes": "runtimes"`
- `apps/desktop/runtimes/` 整目录删除（含 preset/）
- `<repo>/apps/desktop/.local-runtimes/` 加入 gitignore（dev 下载落点）

## 7. 兼容性

- **旧 config 不存在**：默认镜像（清华 / npmmirror）+ 无运行时 → 触发首启引导下载。Resolver 在无 config 时返回 `RuntimeMissing`，不崩。
- **公开 API 签名不变**：`python()` / `node()` / `resolve_runtime_command()` / `require_runtime_command()` / `env()` / `path_value()` 签名保持，调用方零改动（仅 `from_app(&app)` → `resolve(&app)` 一处重命名）。
- **tab id `cli` 保留**：onboarding 跳转不破坏。
- **dev 兼容**：P0 Step 1 保留 `dev_runtimes_dir()` 读取作为 dev 兜底（指向 `.local-runtimes/` 或 `LINGFANG_RUNTIME_DIR`），Step 4 才真正删仓库内 `runtimes/`，避免 dev 中断。

## 8. Rollout / Rollback

- **Rollout**：分阶段（见 `implement.md`），每步独立提交、可独立验证。Step 1–3 不破坏现状（resolver 仍能读旧内置目录），Step 4 才删 runtimes，Step 5–6 接 UI。
- **Rollback**：每步独立 git commit，单步 revert 即可。Step 4 后若下载管线出严重问题，回退需重新打包带 runtimes（接受短期回滚成本）。

## 9. Tradeoffs

- **dev 也走下载**：dev/生产一致性好（不会 dev 测不出生产 bug），代价是首次 `pnpm dev` 要等下载。
- **放弃预装 preset**：首次插件运行需联网装依赖较慢，但模型更干净（每个插件自管依赖）。P1 预装基础包加速。
- **python-build-standalone GitHub 源**：国内下载风险，靠可配 mirror + 多候选源 + 提示代理缓解；P1 自建 CDN。

## 10. 关键不变式验证点（review 时关注）

- Resolver 任何分支都不查系统 PATH（grep 确认无 `which` / PATH 搜索进入 resolver）
- `env()` 永远清空宿主 PATH 后再注入（测试覆盖：`env_replaces_path_and_adds_cn_mirrors` 改为读 config 后仍通过）
- `bundled_pip_wheel_dir` 在 portable python 下命中（下载后立即验证 `Lib/ensurepip/_bundled/pip-*.whl` 存在）
