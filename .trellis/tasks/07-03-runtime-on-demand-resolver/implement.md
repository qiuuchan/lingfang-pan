# Implement: 移除内置运行时改为按需下载与统一Resolver

执行顺序严格自上而下。每步结束独立 git commit，作为 rollback point。Step 1–3 不破坏现状（resolver 仍能读旧内置目录作 dev 兜底），Step 4 才真正删 runtimes。

## Step 1 · Resolver 重构 + config 持久化

- [ ] 新增 `runtime_config.rs`：`RuntimeConfig` / `ManagedEntry` / `MirrorConfig` serde（camelCase alias）；`read_config` / `write_config` 复用 plugin_store 的原子读写模式；config 路径 `app_data_dir/runtimes/.lingfang/runtime-config.json`（dev 用 `<repo>/apps/desktop/.local-runtimes/.lingfang/`）
- [ ] 新增 `mirror_presets.rs`：pip（清华/阿里/腾讯/华为/官方）、npm（npmmirror/华为/腾讯/官方）清单 + 默认值
- [ ] 重构 `embedded_runtime.rs` → `runtime_resolver.rs`：`RuntimeSource` 枚举；`RuntimeResolver::resolve(&app)` 按 §3 优先级解析；`env()` 从 `config.mirrors` 读 URL；删硬编码常量 `PIP_INDEX_URL` / `NPM_REGISTRY` / `PLAYWRIGHT_DOWNLOAD_HOST`
- [ ] 保留 `dev_runtimes_dir()` 作 dev 兜底（指向 `.local-runtimes/` 或 `LINGFANG_RUNTIME_DIR`）；生产严格只读 config
- [ ] 更新所有 `EmbeddedRuntime::from_app(&app)` 调用点 → `RuntimeResolver::resolve(&app)`（grep 确认全部命中：`plugin_runner.rs` / `plugin_script.rs`）
- [ ] `main.rs` mod 声明更新
- [ ] 改单测 `env_replaces_path_and_adds_cn_mirrors` → 读 config 后仍断言 PATH 清空 + 镜像注入
- **验证**：`cargo test -p lingfang-desktop`（resolver 优先级、env 镜像切换、PATH 清空、路径失效降级）
- **Review gate**：确认 resolver 无 config 时返回 `RuntimeMissing`，不静默回退；grep 确认 resolver 内无系统 PATH 搜索

## Step 2 · 下载管线

- [ ] `Cargo.toml` 加 `semver = "1"`、`zip = "2"`、`flate2`、`tar`（reqwest / sha2 已有）
- [ ] 新增 `runtime_download.rs`：`download_runtime(kind, version, app_handle)` →
  - 下载到 `.download/{kind}-{ver}.part`（reqwest Range 断点续传）
  - SHA256 校验（拉 `.sha256` 或 `SHASUMS256.txt`）
  - 解压到 `.staging/{kind}-{ver}/`（zip / tar.gz）
  - 同卷 rename → `{kind}-{ver}/` 原子落盘
  - 验证关键文件（python: `python.exe` + `Lib/ensurepip/_bundled/pip-*.whl`；node: `node.exe`）
  - 写 config `app_managed_*` 激活 + 清理临时
- [ ] 进度 Tauri event：`runtime-download-progress { kind, downloaded, total }` + `runtime-download-stage { kind, stage }`
- [ ] 重试：网络失败指数退避 3 次；解压/校验失败删 staging
- [ ] 多候选下载源（Node: nodejs.org → npmmirror；Python: GitHub → gh-proxy）
- **验证**：单元测试（SHA256 失败拒绝、原子落盘、断点续传字节对齐）；手动调命令触发下载
- **Review gate**：下载后 `bundled_pip_wheel_dir` 命中验证

## Step 3 · Tauri 命令注册

- [ ] `download_runtime(kind, version?)`、`uninstall_runtime(kind)`、`get_runtime_status()` → 返回 `{ python: RuntimeStatus, node: RuntimeStatus }`
- [ ] `get_runtime_config()`、`set_mirror_config(mirrors)`、`set_user_specified_runtime(kind, path?)`
- [ ] `probe_system_runtime(kind)` → 仅信息展示（PATH 搜索 + 版本 + meets_minimum），不参与执行
- [ ] `main.rs` `generate_handler!` 注册全部新命令
- **验证**：`cargo build`；前端 `lib/runtime-config.ts` 封装后能调通

## Step 4 · 打包瘦身

- [ ] `tools/build-installer.ps1:67` 删 runtimes 复制行（保留 `:68` builtin-plugins）
- [ ] `apps/desktop/src-tauri/tauri.conf.json` `resources` 删 `"../runtimes": "runtimes"`
- [ ] 删除 `apps/desktop/runtimes/` 整目录（含 preset/、README.md）
- [ ] `apps/desktop/.gitignore` 加 `.local-runtimes/`
- [ ] review `tools/create-distribution.ps1` / `start.ps1` 等，若引用 runtimes 一并清理
- **验证**：打包脚本 dry-run 确认 staging 不含 runtimes；安装包体积下降
- **Review gate**：此步后生产强制走下载，确认 Step 1–3 已稳

## Step 5 · 设置页 RuntimeEnvTab

- [ ] 重构 `CliRuntimeTab.tsx` → `RuntimeEnvTab.tsx`（保留 tab id `cli`），三区：
  - 运行时状态：Python/Node 各一行（来源标签 + 版本 + 下载/重下/卸载/指定路径 + 系统探测灰显）
  - 镜像源：pip/npm 下拉 + 自定义 URL + 保存
  - 下载进度：订阅 event 的进度条
- [ ] `lib/cli-types.ts` 加 `RuntimeStatus` / `DownloadProgress` / `MirrorConfig` / `RuntimeSource` 类型
- [ ] `lib/runtime-config.ts` 封装全部运行时命令
- [ ] `components/runtime/DownloadProgress.tsx` 订阅 `runtime-download-progress` event
- [ ] `pages/Settings.tsx` probe 逻辑改调 `get_runtime_status`
- **验证**：UI 走查；改镜像源保存后 config 落盘；下载按钮触发进度条
- **Review gate**：卸载运行时后状态正确变「未安装」

## Step 6 · 首启引导 + onboarding 联动

- [ ] `components/runtime/RuntimeSetupGate.tsx`：启动调 `get_runtime_status`，node+python 都缺 → 全屏引导卡（一键下载两个 / 跳过先用 client 插件）；完成写 localStorage `lf:runtime-setup-done`
- [ ] `App.tsx` 集成（不阻塞 client 插件功能）
- [ ] `components/onboarding/task-steps.ts` 第 1 步文案改「下载便携版 Node.js / Python」
- [ ] `components/onboarding/TaskChecklist.tsx` 第 1 步完成判定 → 至少一个运行时就绪
- [ ] `lib/onboarding-progress.ts` 加 runtime ready 探测
- **验证**：删 config 冷启动 → 弹引导 → 一键下载 → 就绪 → 引导消失

## 验证命令

```bash
cargo test -p lingfang-desktop          # resolver / download / env 单测
cargo build -p lingfang-desktop         # Rust 编译
pnpm --filter desktop typecheck         # 前端类型
pnpm --filter desktop lint              # 前端 lint
```

端到端验收见 `prd.md` Acceptance Criteria（7 项）。

## Rollback Points

- 每步独立 git commit，单步 revert 即可
- Step 1 保留 `dev_runtimes_dir()` 兜底，Step 4 才删 runtimes —— Step 1–3 期间 dev 仍可用旧内置目录
- Step 4 后若下载管线严重故障，回退需重新打包带 runtimes（接受短期成本）

## P1（本任务不做，后续）

- 下载就绪后自动预装基础包（迁移 preset 到 `src-tauri/preset/`）
- 多版本共存 + 默认版本切换
- 断点续传深度稳健性 + 多镜像兜底
- 自建 CDN 镜像 python-build-standalone
