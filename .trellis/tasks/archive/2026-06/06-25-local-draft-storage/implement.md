# 实施计划：本地草稿插件存储

## 实施顺序

分 4 个阶段，每个阶段独立可测，避免大爆炸式集成。

---

## 阶段 1：Rust 后端基础（Tauri 命令）

**目标**：实现 4 个 Tauri 命令，能够保存/列出/加载/删除本地草稿。

### 1.1 创建 `draft_plugin.rs` 模块

- [ ] 创建 `apps/desktop/src-tauri/src/draft_plugin.rs`
- [ ] 定义数据结构：`DraftManifest`, `DraftMeta`, `PluginFile`
- [ ] 实现辅助函数 `get_draft_dir(app: &AppHandle) -> Result<PathBuf>`

### 1.2 实现 `save_draft_plugin` 命令

- [ ] 创建草稿目录 `{appDataDir}/plugins-draft/{id}/`
- [ ] 写入 `manifest.json`（含 `draft: true`）
- [ ] 写入 `.meta.json`（创建时间、来源）
- [ ] 写入源文件（支持子目录）
- [ ] 错误处理：目录创建失败、文件写入失败

**验证命令**：

```bash
# 测试：手动调用 Tauri 命令（需要先启动开发服务器）
# 或在前端 console 执行：
await window.__TAURI__.invoke('save_draft_plugin', {
  id: 'test-plugin',
  manifest: { id: 'test-plugin', name: '测试插件', version: '0.0.1', entry: 'index.ts', draft: true },
  files: [['index.ts', 'export default function() { return "Hello"; }']]
});
# 验证：检查 %APPDATA%/com.lingfang.desktop/plugins-draft/test-plugin/ 目录生成
```

### 1.3 实现 `list_draft_plugins` 命令

- [ ] 读取 `{appDataDir}/plugins-draft/` 目录
- [ ] 遍历每个子目录，读取 `manifest.json` 和 `.meta.json`
- [ ] 合并为 JSON 对象，附加 `local: true`, `draft: true`
- [ ] 跳过损坏的草稿（manifest 缺失或解析失败）

**验证命令**：

```bash
await window.__TAURI__.invoke('list_draft_plugins');
# 预期返回：[{ id: 'test-plugin', name: '测试插件', draft: true, local: true, _meta: {...} }]
```

### 1.4 实现 `load_draft_plugin` 命令

- [ ] 读取指定 ID 的 `manifest.json`
- [ ] 读取所有源文件（排除 `.` 开头和 `manifest.json`）
- [ ] 返回完整插件对象（含 `files` 数组）

### 1.5 实现 `delete_draft_plugin` 命令

- [ ] 删除整个草稿目录 `{appDataDir}/plugins-draft/{id}/`
- [ ] 错误处理：目录不存在、删除失败

### 1.6 注册命令到 `lib.rs`

- [ ] `mod draft_plugin;`
- [ ] 在 `invoke_handler` 中注册 4 个命令
- [ ] 添加依赖（如果需要）：`serde_json`, `chrono`（检查 `Cargo.toml`）

**验证**：

```bash
cd apps/desktop
pnpm tauri dev
# 在浏览器 console 测试上述 4 个命令
```

---

## 阶段 2：前端 API 封装

**目标**：封装 Tauri 调用，提供类型安全的 TypeScript API。

### 2.1 扩展类型定义

- [ ] 编辑 `apps/desktop/src/lib/types.ts`
- [ ] 在 `LoadedPlugin` 接口增加字段：
  ```typescript
  draft?: boolean;
  local?: boolean;
  _meta?: {
    createdAt: string;
    updatedAt: string;
    source: string;
    publishedToTeam?: boolean;
  };
  ```

### 2.2 创建草稿管理 API

- [ ] 创建 `apps/desktop/src/lib/draft-plugin.ts`
- [ ] 实现 `saveDraftPlugin(args: SaveDraftArgs): Promise<void>`
- [ ] 实现 `listDraftPlugins(): Promise<LoadedPlugin[]>`
- [ ] 实现 `loadDraftPlugin(id: string): Promise<LoadedPlugin>`
- [ ] 实现 `deleteDraftPlugin(id: string): Promise<void>`
- [ ] 错误处理：`invoke` 失败时抛出清晰的错误消息

**验证**：

```typescript
import { saveDraftPlugin, listDraftPlugins } from '@/lib/draft-plugin';

await saveDraftPlugin({
  id: 'api-test',
  manifest: { id: 'api-test', name: 'API 测试', version: '0.0.1', entry: 'index.ts', draft: true },
  files: [['index.ts', 'export default function() { return "API OK"; }']],
});

const drafts = await listDraftPlugins();
console.log(drafts); // 应包含 'api-test'
```

---

## 阶段 3：创建器改造（保存本地草稿）

**目标**：把创建器的"提交到团队"改为"保存草稿到本地"。

### 3.1 修改 `CreatorDraftPanel.tsx`

- [ ] 改 `handleSubmit` 为 `handleSaveDraft`
- [ ] 调用 `saveDraftPlugin` 而非 `submitStagedPlugin`
- [ ] 按钮文案改为"保存草稿到本地"
- [ ] 提示文案改为"保存后可在插件中心查看和运行"
- [ ] 保存成功后 `toast.success('草稿已保存到本地')`

### 3.2 修改 `FloatingCreator.tsx`

- [ ] `onDraftSubmitted` 改名为 `onDraftSaved`
- [ ] 成功提示改为"草稿已保存"
- [ ] 成功卡片文案改为"草稿已保存，可在插件中心「我的草稿」查看"

**验证**：

```bash
# 启动桌面端开发服务器
pnpm tauri dev
# 打开创建器 → AI 创建插件 → 点"保存草稿到本地"
# 预期：toast 提示成功，关闭创建器后草稿仍在
```

---

## 阶段 4：插件管理 UI（草稿列表 + 发布）

**目标**：插件中心显示草稿列表，支持运行、发布到团队、删除。

### 4.1 修改 `App.tsx` 加载逻辑

- [ ] 在 `loadPlugins` 中调用 `listDraftPlugins()`
- [ ] 合并团队插件和本地草稿：`[...teamPlugins, ...localDrafts]`
- [ ] 错误处理：`listDraftPlugins` 失败时 fallback 到空数组

### 4.2 修改 `PluginCenterDialog.tsx`

- [ ] Tab 列表增加"我的草稿"
- [ ] 筛选逻辑：`activeTab === '我的草稿'` → 筛选 `p.draft && p.local`
- [ ] 草稿项显示草稿徽章（`<Badge>草稿</Badge>`）
- [ ] 草稿项操作按钮：
  - "运行"（与正式插件相同）
  - "发布到团队"（调用 `submitStagedPlugin`，上传到后端）
  - "删除草稿"（调用 `deleteDraftPlugin`）

### 4.3 实现"发布到团队"功能

- [ ] 新增 `publishDraftToTeam(plugin: LoadedPlugin)` 函数
- [ ] 调用 `loadDraftPlugin(plugin.id)` 获取完整文件
- [ ] 调用现有的 `/api/plugins/upload` API
- [ ] 发布成功后标记草稿 `.meta.json` 的 `publishedToTeam: true`（可选）
- [ ] 刷新插件列表

### 4.4 修改 `Sidebar.tsx` 显示草稿徽章

- [ ] 在插件名旁边显示 `{plugin.draft && <Badge variant="outline">草稿</Badge>}`
- [ ] 确保草稿插件可以运行、固定（与正式插件行为一致）

**验证**：

```bash
# 完整流程测试
1. 打开创建器 → AI 创建插件 → 保存草稿
2. 关闭创建器
3. 打开插件中心 → "我的草稿" Tab → 看到刚才的草稿
4. 点"运行" → 草稿插件正常执行
5. 点"发布到团队" → 上传成功，后端可见
6. 删除草稿 → 本地文件被清理
```

---

## 回滚计划

如果某个阶段出现阻塞问题：

1. **阶段 1 阻塞**（Rust 文件系统权限问题）→ 降级为 localStorage 存储草稿（暂存内存，刷新丢失）
2. **阶段 2-4 阻塞**（前端集成问题）→ 保留 Rust 命令，前端暂时不调用，回退到"直接上传团队"逻辑

## 测试清单

- [ ] Rust 单元测试：`save_draft_plugin` 创建正确的目录结构
- [ ] Rust 单元测试：`list_draft_plugins` 返回正确的草稿列表
- [ ] 前端集成测试：AI 创建 → 保存草稿 → 关闭重开 → 草稿仍在
- [ ] 前端集成测试：运行草稿插件 → 与正式插件行为一致
- [ ] 前端集成测试：发布草稿到团队 → 后端可见
- [ ] 前端集成测试：删除草稿 → 本地文件被清理
- [ ] 边界测试：草稿 ID 与团队插件冲突（发布时后端拒绝）
- [ ] 边界测试：草稿文件被外部删除（列表时跳过）

## 预估时间

- 阶段 1（Rust 后端）：2-3 小时
- 阶段 2（前端 API）：30 分钟
- 阶段 3（创建器改造）：1 小时
- 阶段 4（插件管理 UI）：2 小时
- 测试与调试：1-2 小时

**总计**：6-8 小时（可分多次完成）
