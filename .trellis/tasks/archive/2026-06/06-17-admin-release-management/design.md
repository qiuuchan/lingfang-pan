# 技术设计：admin 版本发布管理页

## 架构与边界

纯 admin 前端新页面，后端零改动（API 齐全）。改动范围：

- `apps/collab-admin/src/lib/navigation.ts` — 加 `releases` view 导航项（「系统」分组）。
- `apps/collab-admin/src/lib/types.ts` — 加 `View` 联合类型 `'releases'`；加 Release/ReleaseAsset admin 类型（复用 `lib/releases.ts` 的公开 Release/ReleaseAsset，补充 admin 需要的 status/channel 字段）。
- `apps/collab-admin/src/lib/api.ts` — **扩展 `api()` 支持 FormData**（上传用），或新增 `uploadFile()` 辅助。
- `apps/collab-admin/src/components/releases-view.tsx` — **新增**主页面（列表 + 创建 + 详情 + 上传 + 发布/归档 + 外链登记 + 删 asset）。
- `apps/collab-admin/src/App.tsx` — lazy import ReleasesView + 路由分支 `view === 'releases'`。

## 数据流与契约

### API 封装（新增到 api.ts 或 releases.ts）

| 方法 | 端点 | 用途 |
|---|---|---|
| `listAdminReleases()` | `GET /api/admin/releases` | 列表（含 DRAFT/ARCHIVED，公开端点只返 PUBLISHED）|
| `createRelease(body)` | `POST /api/admin/releases` | 创建 DRAFT |
| `updateRelease(id, body)` | `PATCH /api/admin/releases/:id` | 改 title/notes |
| `publishRelease(id)` | `POST /api/admin/releases/:id/publish` | 发布 |
| `archiveRelease(id)` | `POST /api/admin/releases/:id/archive` | 归档 |
| `addAsset(id, body)` | `POST /api/admin/releases/:id/assets` | 登记外链 asset |
| `uploadAsset(id, file, platform, arch)` | `POST /api/admin/releases/:id/assets/upload` | 上传安装包（multipart）|
| `deleteAsset(id, assetId)` | `DELETE /api/admin/releases/:id/assets/:assetId` | 删 asset |

**注意**：后端无 `GET /api/admin/releases`（列表）端点？需查证。若仅有公开 `GET /api/releases`（只返 PUBLISHED），admin 列表看不到 DRAFT/ARCHIVED——需后端补 admin 列表端点，或前端用公开端点 + 约束（admin 只能管理 PUBLISHED？不行）。

→ **查证项**：admin.controller 是否有 `GET releases` 列表端点。若无，本任务需后端补一个（小改动）。

### 上传 FormData 契约

后端 `FileInterceptor('file')` + body `{ platform, arch }`：
```
FormData:
  file: <LingFang_0.0.2_x64-setup.exe>
  platform: WINDOWS
  arch: X86_64
```
后端自动：落 `downloads/<随机前缀>_<文件名>`，url=`/downloads/<...>`，sizeBytes=文件大小。

### api() 扩展（FormData）

当前 `api()` 硬编码 `Content-Type: application/json` + `JSON.stringify(body)`。扩展方案：
- `ApiOptions` 加 `formData?: FormData` 字段。
- 有 formData 时不设 Content-Type（浏览器自动加 multipart boundary），body 直接传 FormData。
- 其余（token、timeout、错误处理）复用。

## 关键设计决策

### D1：.sig 签名文件上传（updater 验签必需，已决策）

**问题**：后端 `uploadAsset` 只 `FileInterceptor('file')` 接收 .exe，.sig 读取逻辑是从 `downloads/<uniqueName>.sig` 读——但前端没传 .sig，所以 signature 永远空。updater 验签会失败。

**决策**：后端改用 `FileFieldsInterceptor` 同时接收 .exe（field: `file`）+ .sig（field: `signature`）。上传时：
- .exe 落 `downloads/<随机前缀>_<文件名>`，url=`/downloads/<...>`。
- .sig 内容直接读为 signature 填入 asset（不再依赖同名文件读取）。
- .sig 可选（未传则 signature 留空，兼容纯下载场景）。

**后端改动**（`admin.controller.ts` + `release.service.ts`）：
- controller：`FileInterceptor('file')` → `FileFieldsInterceptor({ file, signature? })`，`@UploadedFiles()`。
- service：`uploadAsset` 签名加 `sigFile?` 参数，有则 `readFileSync(sigFile.path)` 或 `sigFile.buffer.toString()` 填 signature，删除原「读同名 .sig」逻辑。

**前端**：FormData 同时 append `file`（.exe）+ `signature`（.sig）。用户在 file picker 选 .exe 后，自动找同名 .sig 一并上传（或两个 file input）。

### D2：admin 列表端点（已查证，需后端补）

**查证结论**：`admin.controller.ts` 的 release 相关端点只有 POST 创建 / PATCH 改 / POST publish/archive/assets/upload + DELETE，**无 `GET /api/admin/releases` 列表端点**。公开 `GET /api/releases` 只返 PUBLISHED，admin 看不到 DRAFT/ARCHIVED。

**方案**：后端补 `GET /api/admin/releases`（返全部 status，ensurePlatformAdmin），与现有 admin 写端点对称。release.service 已有 `listReleases` 私有逻辑（公开端点用），admin 版去掉 PUBLISHED 过滤即可复用。工作量小（controller 加一个 @Get + service 加 admin list 方法）。

→ 本任务含此后端小改（不止纯前端）。

### D3：UI 结构

参考 plugins-view 模式：
- 顶部：channel 筛选（STABLE/BETA/全部）+ 「创建版本」按钮。
- Table：version / channel / title / status（DRAFT/PUBLISHED/ARCHIVED Badge）/ isLatest / asset 数 / publishedAt / 操作（详情/发布/归档）。
- DetailSheet：版本详情 + asset 列表（下载链接可复制 + 删除）+ 上传安装包区（platform/arch 选择 + file input + 上传按钮）+ 登记外链 asset 表单 + 编辑 title/notes。
- 创建/编辑/发布/归档/删除：Dialog 二次确认。

## 兼容性与迁移

- 后端零改动（除 D2 可能补列表端点）。
- 公开端点 `/api/releases`、`/api/releases/tauri-update` 不动。
- 现有 8 个 admin view 不受影响（新增 view 独立）。
- v0.0.2 安装包上传后，DownloadPage 自动展示（已用 getLatestRelease）。

## 回滚

纯前端新增页面 + 导航项，回滚 = 删除 releases-view.tsx + 撤 navigation/App/types 改动。后端若有 D2 小改，回滚对应端点。
