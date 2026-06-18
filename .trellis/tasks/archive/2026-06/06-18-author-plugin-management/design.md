# 作者侧插件管理 — 技术设计

## 1. 边界与契约

### 1.1 新增后端能力：editPluginMeta

**为什么不复用 `editPluginDraft`**：`editPluginDraft` 语义是「改源码」——要求完整 `files`、重算 `contentHash`、强制 `reviewStatus=DRAFT`、`marketplace=false`（见 plugin.service.ts:176-216）。仅改个名字/描述/图标走这条路会把已通过审核的插件打回草稿、要求重传整包，不符合需求。因此新增轻量 `editPluginMeta`。

**Service 签名**（`apps/collab-api/src/modules/plugin.service.ts`）：

```ts
async editPluginMeta(
  userId: string,
  id: string,
  input: { name?: string; description?: string; icon?: string },
): Promise<{ plugin: PublicPlugin }>
```

**逻辑**：
1. `ensureCurrentTeam(userId)` → membership。
2. `findUnique({ id })`，不存在 `notFound('插件不存在')`。
3. `ensurePluginManager(plugin, teamId, userId, role)`（作者或团队管理员）。
4. 状态约束：
   - `reviewStatus === 'PENDING'` → `conflict('审核中的插件不能编辑，请等待审核完成')`（与 editPluginDraft 一致）。
   - **已上架（`reviewStatus==='APPROVED' && marketplace`）的处理**：**允许仅改元数据**。理由：名称/描述/图标是展示信息，不改源码、不改 `contentHash`、不改定价与可见性，不触发已购用户的功能性变化；阻断它会逼作者走「下架→改名→重审」的重流程，体验差。与 `editPluginDraft`（改源码必须重审）区别明确。此决策写入代码注释。
5. 入参归一与校验（service 内兜底，DTO 也校验）：
   - `name`：若提供，`trim()` 后非空，长度 ≤ 既有 manifest name 上限（对齐 `normalizePluginPackage` 约束，design 实现时查证具体值；保守取 ≤ 80 字符）。
   - `description`：允许空串，长度上限对齐既有约束（保守 ≤ 500 字符）。
   - `icon`：见 §1.3 图标格式与上限。
   - 至少一项被提供，否则 `badRequest('至少需要提供一项要修改的字段')`。
6. 构造更新数据：读出现有 `manifest`（Json），浅合并 `{ ...manifest, name?, description?, icon? }`，回写：
   - 顶层 `name`/`description`（仅当对应入参提供时更新）
   - `manifest`（含 icon/name/description 同步）
   - 不动 `files`/`contentHash`/`reviewStatus`/`marketplace`/`priceCents`/`version`/`entry`/`runtimeType`/`visibility`/`capabilities`。
7. `audit(userId, 'plugin.meta.edited', 'Plugin', id, { teamId, fields: 改了哪些字段名 })`（不记录图标 base64 内容，避免日志膨胀与敏感冗余）。
8. 返回 `publicPlugin(updated, teamId)`。

### 1.2 REST 端点与 DTO

**Controller**（`apps/collab-api/src/modules/plugins.controller.ts`）：

```ts
@Post(':id/edit-meta')
@ApiOperation({ summary: '编辑插件元数据（名称/描述/图标，不重置审核态、不改源码）' })
editMeta(@Req() req, @Param('id') id, @Body() body: EditPluginMetaDto) {
  return this.plugins.editPluginMeta(requireUser(req).id, id, body);
}
```

**DTO**（`apps/collab-api/src/modules/dto/plugins.dto.ts`）：

```ts
export class EditPluginMetaDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  // icon：base64 data URI 或 emoji 或短 URL；上限防止 manifest 膨胀。
  @IsOptional() @IsString() @MaxLength(ICON_MAX_LEN) icon?: string;
}
```

具体 MaxLength 值在实现时对齐 `normalizePluginPackage` 现有上限（查 plugin-package.ts），保持一致。

### 1.3 图标格式与上限（决策）

- **存储位置**：`manifest.icon`（字符串）。不加 schema 列、不做服务端文件存储（PRD 非目标）。
- **接受格式**：
  - emoji / 短文本字符（如 "🧩"）—— 最轻，作者中心提供 emoji 直填。
  - base64 data URI（`data:image/png;base64,...` / webp / svg+xml）—— 支持用户选本地图片。
- **上限**：图标 base64 上限取 `ICON_MAX_LEN`（建议 64KB 字符，约 48KB 图片）。超限 DTO 拒绝，前端在选图后压缩/校验大小并提示。
- **渲染兜底**：`manifest.icon` 为空时，作者中心与插件列表用首字母/默认图标占位（复用现有占位逻辑，若无则用 runtimeType 对应 lucide 图标）。

## 2. 前端结构

### 2.1 View 与路由

- `apps/desktop/src/lib/types.ts:148` 的 `View` 联合类型增加 `'author-center'`。
- `apps/desktop/src/App.tsx` 路由 switch 增加分支渲染 `<AuthorCenter />`。
- `apps/desktop/src/components/Sidebar.tsx` 增加入口项（图标用 lucide，如 `LayoutDashboardIcon` / `PackageIcon`），文案「作者中心」或「我的插件」。可见性：所有登录用户可见（是否有插件由列表空态提示）。

### 2.2 AuthorCenter 页面（新文件 `apps/desktop/src/pages/AuthorCenter.tsx`）

- 加载：`api('/api/plugins/mine')` → `{ plugins: LoadedPlugin[] }`，`useState` + `useEffect` 首载，提供手动刷新按钮（RefreshCwIcon，与本地插件刷新风格一致；与 06-18-plugin-status-refresh 协调）。
- 列表项复用/抽取 `PluginList.tsx` 的卡片结构。**复用策略**：将 `PluginPriceEditDialog`/`PluginStatusToggle`/`PluginDeleteDialog` 从 `PluginList.tsx` 提取为可复用导出（或新建 `apps/desktop/src/components/plugins/author-actions.tsx` 收纳），AuthorCenter 与 PluginList 共用，避免重复实现。
- **新增控件**：
  - `PluginMetaEditDialog`：表单含 名称（Input）、描述（Textarea）、图标（emoji Input + 本地选图按钮，选图后转 base64 校验大小）。保存调 `POST /api/plugins/:id/edit-meta`，成功 toast + 刷新。
  - `PluginSubmitDialog`：提交上架，调 `POST /api/plugins/:id/submit-marketplace`（可带 priceCents），展示审核流程说明。仅当插件未在 PENDING/已上架时可点。
- 图标展示：列表项左侧渲染 `manifest.icon`（img / emoji span / 占位）。

### 2.3 类型

- `LoadedPlugin`（`apps/desktop/src/lib/types.ts:123-146`）确认含 `manifest`、`reviewStatus`、`priceCents`、`status`、`source`。图标从 `plugin.manifest?.icon` 读取，必要时给 manifest 类型补 `icon?: string`。

## 3. 数据流

```
AuthorCenter 首载/刷新
  → GET /api/plugins/mine
  → myPlugins(): where { authorUserId, teamId }, publicPlugin 序列化（含 manifest.icon）
  → 列表渲染（图标 + Badge）

编辑元数据
  → PluginMetaEditDialog 提交 { name?, description?, icon? }
  → POST /api/plugins/:id/edit-meta
  → editPluginMeta(): 浅合并 manifest、同步顶层 name/description、审计
  → 成功 → onSaved() → 重新 GET /api/plugins/mine
```

## 4. 兼容性 / 回滚

- 后端纯新增端点 + service 方法 + DTO，不改既有端点签名 → 向后兼容，回滚即删除新增代码。
- 前端纯新增页面 + View 分支 + 侧边栏入口；抽取共享组件时保持 PluginList 行为不变（重构等价）。
- 无 schema 迁移（图标走 manifest JSON），无数据迁移风险。

## 5. 安全与权限

- 复用 `ensurePluginManager`（作者/团队管理员），不新增也不削弱鉴权（按项目约定，安全非验收重点，但既有校验保持以保证功能正确）。
- 图标 base64 渲染：作者中心内 `<img src={dataUri}>` 仅渲染作者自己上传的图标，限定 data URI / 已知格式；不引入 iframe / 不执行脚本。SVG 图标如允许需注意（建议图标仅接受位图 data URI + emoji，不接受 svg+xml 以规避 XSS，design 决策：**图标不接受 `image/svg+xml`**）。

## 6. 风险点

- 抽取 PluginList 共享组件可能影响现有插件页行为 → 用「等价重构」方式，改完回归插件页改价/启停/删除仍正常。
- manifest 浅合并需保留未知字段（capabilities 等不在 manifest 顶层但 entry/runtime 在）→ 只动 name/description/icon，其余键透传。
- 图标 base64 体积 → DTO MaxLength + 前端选图大小校验双重把关。
