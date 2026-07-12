# Local Plugin Package Manager

## Scenario: Verified Installations And Draft Workspaces

### 1. Scope / Trigger

- 修改 v4 打包/解压、本机安装、pending 激活、回滚、卸载、内置注册或草稿工作区时适用。
- Rust JSON ledger 是本机安装与草稿元数据的唯一事实源。

### 2. Signatures

- Tauri：`list/install/load/start/stop/rollback/uninstall_plugin_*`。
- Tauri：`list/create/import/copy/pack/publish/delete/sync_draft_workspace*`。
- Ledger：`installations-v1.json`、`workspaces-v1.json`、`plugin-layout-migration-v1.json`。
- 传输命令在 `plugin_package_manager/network.rs`；主模块超过 1500 行前必须继续拆分。

### 3. Contracts

- 目录：`installed/<installationId>/releases/<releaseId>/package`、共享 `data`、`cache`、`workspaces/<workspaceId>`、staging。
- `releaseId` 进入目录前必须通过跨平台单段白名单；本地产生的 local/legacy/builtin releaseId 使用 SHA 派生且不得含 Windows 非法字符。
- 安装顺序：inspect/SHA -> staging 安全解压 -> data link -> rename immutable release -> cache -> atomic ledger。
- 更新写 `pendingRelease`；只有依赖准备且进程成功启动后才激活，保留一个 previous release。
- client/cloud 更新先用 `preview_pending_installed_plugin` 读取待激活入口，iframe 成功加载后再调用 `activate_pending_client_plugin`；列表 hydration 始终读取 active。
- Python：`uv.lock -> uv sync --frozen`，`requirements.txt -> uv pip install --python`；Node：pnpm frozen 或 `npm ci`。
- 卸载通过 rename 到 staging 保证账本失败可回退，成功后删除代码、data 和外置 Python venv；builtin protected 禁止卸载。
- `.lfplugin` 不保存 draft/source/install 状态。导入目标由调用页面决定。
- 内置源码只作为构建输入；`build.rs` 在 `OUT_DIR` 生成确定性 v4 制品和 SHA 索引并嵌入二进制，启动时经同一安装器注册，生产资源不携带源码目录。

### 4. Validation & Error Matrix

- SHA 不符或 ZIP/manifest 非法 -> ledger 和 final release 零变更。
- final release 已存在/相同 release 重装/已有 pending -> 拒绝覆盖。
- pending 首次启动失败 -> 标为 failed，active 不变。
- 无 previous 回滚、protected 卸载、团队插件未在线授权启动 -> 明确错误。
- workspace 同内容、同版本或版本未提升 -> 禁止发布。

### 5. Good/Base/Bad Cases

- Good：`1.1.0` 下载为 pending，启动失败仍运行 `1.0.0`，成功后切 active 并保留 `1.0.0`。
- Base：本地导入没有 packageId 时使用 `local:<manifestId>`；复制安装项先生成干净 v4 再导入 workspace。
- Bad：WebView 用 JSZip 缓冲制品、直接编辑 installed release、卸载只删 ledger 或只删目录。

### 6. Tests Required

- 确定性 ZIP、攻击路径、checksum 零变更、install 原子性、pending/activate/rollback。
- copy-to-workspace 排除 data/runtime，uninstall 删除共享 data，builtin protected。
- legacy migration journal 幂等、单项失败可重试且保留旧目录。

### 7. Wrong vs Correct

Wrong：先删安装目录再写账本，写失败后留下悬空记录。

Correct：rename 到 staging，提交 ledger；任一步失败恢复旧 ledger/目录，最后清理 staging 和环境。
