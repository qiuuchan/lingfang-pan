# `.lfplugin` v4 压缩包内部格式

> 真相来源：Rust 源码 `plugin_artifact_v4.rs` + 实物 `.lfplugin` 文件逆向。
>
> 此文档驱动 `src/cli/util/archive.ts` 的 JSZip 打包实现。格式错误 → 桌面壳拒绝该包。

---

## Zip Internal Structure

```
.lfplugin (ZIP, PK\x03\x04)
├── _meta.json                    ← 必需（version marker）
├── manifest.json                 ← 必需（插件清单）
├── <source-file-1>               ← 插件源码文件
├── <source-file-2>
├── ...
└── <source-file-N>
```

**关键约束**（源码 `plugin_artifact_v4.rs:297-298`）：

- ❌ 禁止目录条目（ZIP 中不能有以 `/` 结尾的 entry）
- ❌ 禁止符号链接（`unix_mode` 检查 `0o120000`，见第 300-306 行）
- ❌ 禁止绝对路径、`..`、`\\`（见 `normalized_relative` 第 46-69 行）
- ✅ 所有文件以**扁平路径**放在 ZIP 根目录（无顶层文件夹）
- ✅ 路径分隔符必须是正斜杠 `/`
- ✅ 文件名必须含 `manifest.entry` 指明的入口文件

### 实物验证（3 个已发布的 `.lfplugin`）

| 文件 | 条目 |
|---|---|
| `videodl.lfplugin` | `_meta.json`, `manifest.json`, `README.md`, `main.py`, `requirements.txt`, `url_extractor.py` |
| `pixelle-video.lfplugin` | `_meta.json`, `manifest.json`, `README.md`, `main.py`, `requirements.txt`, `vendor.tar.gz` |
| `huobao-drama.lfplugin` | `_meta.json`, `manifest.json`, `README.md`, `index.js`, `package.json`, `vendor.tar.gz` |
| `facefusion.lfplugin` | `_meta.json`, `manifest.json`, `README.md`, `guide.py`, `main.py`, `requirements.txt`, `vendor/facefusion/...` (95 个文件) |

所有实物文件的 `_meta.json` 内容完全一致（见下方）。

---

## `_meta.json` Location

**ZIP 根路径**：`_meta.json`

源码 `plugin_artifact_v4.rs:203-206`（`package_workspace` 创建时）：

```rust
zip.start_file("_meta.json", options)
    .map_err(|error| format!("写入 _meta.json 失败：{error}"))?;
zip.write_all(b"{\"format\":\"lingfang-plugin\",\"formatVersion\":4}")
    .map_err(|error| format!("写入 _meta.json 失败：{error}"))?;
```

检测时（第 316/339/344 行）：`inspect_artifact` 从所有 ZIP 条目中识别名为 `_meta.json` 的 entry。

---

## Version Marker（v4 声明位置）

**`_meta.json` 文件内容**（固定、无换行，第 205 行硬编码）：

```json
{"format":"lingfang-plugin","formatVersion":4}
```

检测逻辑（第 354-359 行）：

```rust
let meta = meta.ok_or_else(|| "v4 制品缺少 _meta.json".to_string())?;
if meta.get("format").and_then(Value::as_str) != Some("lingfang-plugin")
    || meta.get("formatVersion").and_then(Value::as_u64) != Some(4)
{
    return Err("只支持 .lfplugin v4 制品".to_string());
}
```

### 关键事实

| 问题 | 答案 |
|---|---|
| v4 标记在哪里？ | `_meta.json` 中的 `formatVersion: 4` |
| 是 ZIP comment 吗？ | ❌ 否。ZIP comment 被忽略 |
| 是 manifest 字段吗？ | ❌ 否。manifest.json 不含版本声明 |
| v1/v2/v3 向后兼容吗？ | ❌ **否**。v4 只接受精确的 `formatVersion: 4`。旧版本全部拒绝 |
| 还有 v3 代码吗？ | `plugin_store.rs` 第 410/427/1014/1043 行有引用 `.lfplugin v3` 的注释，但那是旧的导入/导出路径，v4 inspect 不接受它们 |

---

## `manifest.json` Location

**ZIP 根路径**：`manifest.json`

源码 `plugin_artifact_v4.rs:207-211`（创建时）：

```rust
zip.start_file("manifest.json", options)
    .map_err(|error| format!("写入 manifest.json 失败：{error}"))?;
let manifest_bytes = serde_json::to_vec_pretty(&manifest)
    .map_err(|error| format!("序列化 manifest.json 失败：{error}"))?;
zip.write_all(&manifest_bytes)
```

检测时（第 316/339/346 行）：名为 `manifest.json` 的 entry。

### manifest.json 必填字段

源码 `validate_manifest`（第 233-257 行）：

```rust
for field in ["id", "name", "version", "entry", "runtime_type"] {
    // 必须是非空字符串
}
semver::Version::parse(version)  // 必须是严格 SemVer
runtime_type ∈ {"client", "cloud", "nodejs", "python"}
normalized_relative(entry)       // entry 必须是合法相对路径
entry 必须存在于 ZIP 文件中      // 第 362-368 行
```

### 可选字段（从 `plugin_store.rs` 推断）

| 字段 | 类型 | 回退值 |
|---|---|---|
| `title` | string | `name` → `id` |
| `description` | string | `""` |
| `icon` | string? | `None` |
| `draft` | bool | `false` |
| `capabilities` | array | — |
| `visibility` | string | — |

### manifest.json 实物示例（`videodl.lfplugin`）：

```json
{
  "id": "videodl",
  "name": "视频下载器",
  "version": "0.2.0",
  "description": "...",
  "runtime_type": "python",
  "entry": "main.py",
  "capabilities": [
    {
      "kind": "ui.view",
      "reason": "展示视频下载 GUI 界面",
      "risk": "none",
      "requires_admin": false
    }
  ],
  "visibility": "tenant"
}
```

---

## Files Included vs Excluded

### 打包时排除（`package_workspace` 中的 `collect_workspace_source_files`）

源码 `plugin_artifact_v4.rs:17-27`（`EXCLUDED_SEGMENTS`）：

```rust
const EXCLUDED_SEGMENTS: &[&str] = &[
    "data",          // 插件运行时数据
    ".git",          // 版本控制
    ".venv",         // Python venv
    "venv",          // Python venv
    "node_modules",  // Node.js 依赖
    ".lingfang",     // 工作区元数据
    "__pycache__",   // Python 缓存
    ".pytest_cache",
    ".mypy_cache",
];
```

额外规则（第 82-84 行）：
- 任何以 `.pyc` 或 `.pyo` 结尾的文件

`collect_workspace_source_files`（第 124-153 行）额外排除：
- `_meta.json`（第 132 行：由 `package_workspace` 手动创建）
- `manifest.json`（第 190 行：由 `package_workspace` 手动创建）

### 检测时拒绝（`inspect_artifact` 中的 `validate_zip_path`）

同样的排除列表应用于检测（第 259-269 行）——ZIP 中不能包含这些路径。

### 提取时

`extract_artifact`（第 378-434 行）——提取所有 ZIP 条目（不做过滤，因为 inspect 已经过滤过了）。所有文件提取到目标目录。

---

## Extraction Target Layout（安装后磁盘结构）

源码 `plugin_package_manager.rs:889-899`（`install` 函数）：

```
<installation_root>/                        ← self.installed_root()
├── <installation_id>/                      ← UUID 或持久 ID
│   ├── data/                               ← 共享数据目录（跨 release 共享）
│   ├── releases/
│   │   └── <release_id>/                   ← e.g. "local-<sha256[..16]>"
│   │       └── package/                    ← 解压目标（extract_artifact 目标）
│   │           ├── _meta.json
│   │           ├── manifest.json
│   │           └── ...所有源文件...
│   └── environments/                       ← Python venv / Node 环境（可选）
└── ...
```

### `load_release_payload` 如何消费（第 1113-1142 行）

1. `release.path` 指向 `package/` 目录（从安装账本的 `InstalledRelease.path` 字段读取）
2. 读取 `package/manifest.json`
3. 从 manifest 获取 `entry` 字段
4. `package.join(entry)` → 如 `package/main.py`
5. 验证入口文件未越出 `package/` 目录（path traversal 防护）
6. 读取入口文件内容（UTF-8 文本）

### `scan_one_plugin` 如何扫描（`plugin_store.rs:659-760`）

对于 plugins_root 下的草稿目录：
1. `manifest.json` 在目录根
2. `entry` 相对路径基于目录根解析：`dir.join(entry)` → `dir/main.py`
3. 如果入口文件不存在 → status = Incomplete

---

## Implementation Notes for `archive.ts`

### 1. 精确的 ZIP 结构

```typescript
import JSZip from 'jszip';

const zip = new JSZip();
// _meta.json 必须是 ZIP 中的第一个文件（虽然 Rust 不检查顺序，但保持一致性）
zip.file('_meta.json', JSON.stringify({
  format: 'lingfang-plugin',
  formatVersion: 4,
}));
// manifest.json 第二个
zip.file('manifest.json', JSON.stringify(manifest, null, 2));
// 然后所有源文件（按字母顺序，Rust 第 151 行排序）
for (const [name, path] of sortedSourceFiles) {
  zip.file(name, fs.readFileSync(path));
}
// 生成 Buffer
const buffer = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  platform: 'UNIX',  // 确保 unix_permissions 设置正确
});
```

### 2. 约束清单

| 约束 | 值 | Rust 位置 |
|---|---|---|
| 最大 ZIP 大小 | 300 MiB | `MAX_ARCHIVE_BYTES` (L12) |
| 最大解压总大小 | 300 MiB | `MAX_UNCOMPRESSED_BYTES` (L13) |
| 最大单文件大小 | 60 MiB | `MAX_FILE_BYTES` (L14) |
| 最大文件数 | 1500 | `MAX_FILES` (L15) |
| 压缩方式 | Deflate | `SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)` (L199-200) |
| 权限 | `0o644` | `.unix_permissions(0o644)` (L202) |
| 时间戳 | `DateTime::default()` (1970-01-01) | `.last_modified_time(DateTime::default())` (L201) |

### 3. 条目命名规则

- 使用正斜杠作为路径分隔符（`normalized_relative` 第 68 行：`segments.join("/")`）
- 不允许空字符串、`.`、`..`
- 不允许以 `/` 结尾、不允许 `\\`
- 不允许包含排除段（见上表）
- 文件顺序：按路径名**字典序**（Rust 第 151 行：`files.sort_by(|left, right| left.0.cmp(&right.0))`）

### 4. 读取工作区文件

使用 `collect_workspace_source_files` 等价逻辑（Rust 第 124-153 行）：
1. 递归扫描工作区目录
2. 跳过排除的目录/文件
3. 跳过 `_meta.json`（由 JSZip 创建）
4. 跳过 `manifest.json`（由 JSZip 创建）
5. 拒绝符号链接
6. 检查总大小和文件数限制
7. 按字母序排列

### 5. 验证（在 JS 中模拟 `inspect_artifact`）

打包后也应运行这些检查：
1. ZIP 能否被读取（JSZip 可检测）
2. `_meta.json` 必须存在且内容正确
3. `manifest.json` 必须存在且字段完整
4. `manifest.entry` 指向的文件必须在 ZIP 中
5. 无目录条目
6. 无排除路径

### 6. 与 Rust 实现的差异注意事项

| 项目 | Rust 做法 | JS 对应 |
|---|---|---|
| 时间戳 | `DateTime::default()` (Unix epoch) | JSZip 默认使用当前时间——这会导致每次构建 hash 不同。应设置 `date: new Date(0)` |
| 权限 | `0o644` | JSZip 的 `unixPermissions: 0o644` |
| 确定性构建 | ZIP 条目时间戳固定 + 文件排序 + Deflate 压缩 | 确保 `date` 固定、文件顺序稳定、使用相同压缩级别 |

### 7. 压缩选项

```typescript
zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressOptions: {
    level: 6,  // 默认级别，Rust 使用压缩默认
  },
  platform: 'UNIX',
});
```

---

## Truth Source File:Line References

| 功能 | 文件 | 行号 |
|---|---|---|
| `package_workspace`（打包） | `plugin_artifact_v4.rs` | 175-231 |
| `inspect_artifact`（检测） | `plugin_artifact_v4.rs` | 271-376 |
| `extract_artifact`（解压） | `plugin_artifact_v4.rs` | 378-434 |
| `validate_manifest`（清单校验） | `plugin_artifact_v4.rs` | 233-257 |
| `collect_workspace_source_files`（收集文件） | `plugin_artifact_v4.rs` | 124-153 |
| `should_exclude`（排除规则） | `plugin_artifact_v4.rs` | 71-85 |
| `normalized_relative`（路径规范化） | `plugin_artifact_v4.rs` | 46-69 |
| `install`（安装到账本） | `plugin_package_manager.rs` | 832-1000 |
| `load_release_payload`（加载已安装插件） | `plugin_package_manager.rs` | 1113-1142 |
| `pack_workspace`（Tauri 命令级打包） | `plugin_package_manager.rs` | 1527-1542 |
| `scan_one_plugin`（扫描单个插件目录） | `plugin_store.rs` | 659-760 |
| `parse_entry`（entry 字段解析） | `plugin_store.rs` | 775-785 |
| `EXCLUDED_SEGMENTS` | `plugin_artifact_v4.rs` | 17-27 |
| `MAX_ARCHIVE_BYTES` / `MAX_FILES` / 等 | `plugin_artifact_v4.rs` | 12-15 |

---

## 验证 checklist

`archive.ts` 产出 `.lfplugin` 后，用以下命令验证：

```bash
# 1. 确认是有效 ZIP
python -c "import zipfile; z=zipfile.ZipFile('out.lfplugin'); print([e.filename for e in z.infolist()])"

# 2. 确认 _meta.json 内容正确
python -c "import zipfile, json; z=zipfile.ZipFile('out.lfplugin'); print(z.read('_meta.json'))"
# 期望: b'{"format":"lingfang-plugin","formatVersion":4}'

# 3. 用 Rust 的 inspect 验证（需要桌面壳）
# 在 Tauri 命令中调用 inspect_lfplugin_v4("out.lfplugin")

# 4. 确认 manifest.entry 指向的文件存在
python -c "import zipfile, json; z=zipfile.ZipFile('out.lfplugin'); m=json.loads(z.read('manifest.json')); print('entry:', m['entry']); print('exists:', m['entry'] in z.namelist())"
```
