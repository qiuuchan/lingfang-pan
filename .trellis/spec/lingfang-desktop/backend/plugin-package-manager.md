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

## Scenario: V4 Artifact Publishing, Provenance, And Tagged Files

### 1. Scope / Trigger

- 修改 v4 ZIP、草稿文件读取、本地 artifact 直传、workspace 发布或 release 来源 headers 时适用。

### 2. Signatures

- `read_draft_workspace_files(workspaceId) -> Vec<{ path, content, binary }>`：UTF-8 返回原文，非 UTF-8 返回标准 base64 且 `binary=true`。
- `publish_draft_workspace({ apiBase, authToken, workspaceId, packageId?, sourceKind, sourceLabel }, onEvent)`。
- `publish_local_artifact({ apiBase, authToken, artifactPath, packageId?, sourceKind, sourceLabel }, onEvent)`。
- 共享上传器：`upload_artifact_file(path, connection, packageId, provenance, onEvent)`。
- Ledger `DraftWorkspace`：`sourceKind/sourceLabel` 使用 serde default，旧记录读取为 `UNKNOWN/''`。

### 3. Contracts

- v4 ZIP 固定含 `_meta.json { format: "lingfang-plugin", formatVersion: 4 }` 与规范化 `manifest.json`；总 entry 上限 1500，目录导入器最多接收 1498 个源文件为两个固定 entry 预留空间。
- 打包按稳定排序和固定时间戳生成确定性 ZIP；排除 runtime/data/cache/隐藏依赖目录，但保留真实 `dist/build` 入口与资产。
- tagged reader 是 Creator/workspace 重载的唯一二进制安全读取边界；文本批量走 `write_plugin_files`，binary 必须逐个走 `write_plugin_file_bytes`。
- direct artifact publish 先在本机完整 inspect v4，再使用共享流式上传器；不得创建临时 workspace 或 installation。
- 上传请求固定 `X-Client: desktop`，携带 source kind、ingest channel 和 base64url source label；source label 清理后不得包含本机绝对路径。
- 默认来源：Creator=`LINGFANG_CREATOR`，外部目录=`EXTERNAL_TOOL`，artifact=`LOCAL_ARTIFACT`，installation copy=`COPIED_INSTALLATION`，旧 ledger=`UNKNOWN`。

### 4. Validation & Error Matrix

- ZIP entry 超 1500、CRC/EOF/路径/排除段/manifest/runtime/entry 不合法 -> inspect/publish 失败且不发网络请求。
- workspace 缺 manifest、同内容同版本、版本未提升 -> publish 拒绝。
- 非 UTF-8 被文本 reader/writer 处理 -> 视为契约错误；必须返回/消费 `binary=true` base64。
- source label 为 Unix/Windows/UNC 绝对路径或控制字符 -> 替换为该 source kind 默认标签。
- HTTP 非 2xx、流读取或 header 构造失败 -> 返回真实错误，workspace ledger 不标记 published。

### 5. Good/Base/Bad Cases

- Good：PNG 字节经外部目录导入 -> workspace 写入 -> Creator 重开 -> 再保存 -> pack，SHA/字节保持一致。
- Base：旧 workspace ledger 无来源字段仍可打开，发布前归一为 `UNKNOWN`。
- Bad：把 base64 当 UTF-8 文本写盘，或用 WebView/JSZip 缓冲 300MiB artifact 再上传。

### 6. Tests Required

- Rust：tagged UTF-8/binary round trip、1498 source + 2 fixed entries、1499 source 拒绝、确定性 ZIP、CRC/path/manifest 校验。
- Rust network：direct publish 先 inspect、共享流式上传、desktop provenance headers、绝对路径 label 清理。
- 前端：binary writer 分流、workspace source defaults/legacy normalize、direct artifact payload 不泄漏路径。
- 门禁：`cargo fmt --all -- --check`、`cargo test -p lingfang-desktop`。

### 7. Wrong vs Correct

Wrong：`read_local_plugin_file` 返回占位文本后写回 workspace，或 direct upload 在 WebView 读完整制品。

Correct：Rust tagged reader 返回文本/base64 union；前端按 `binary` 分流写入；Rust 共享 uploader 从文件流直接上传。
