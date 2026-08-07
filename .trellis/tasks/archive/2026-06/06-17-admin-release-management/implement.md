# 执行计划：admin 版本发布管理页

## 后端小改（先做，前端依赖）

### B1. 补 admin 版本列表端点（D2）

- `apps/collab-api/src/modules/release.service.ts`：加 `listAdminReleases(channel?)` 方法，复用现有 `listReleases` 逻辑但**去掉 PUBLISHED 过滤**（返全部 status：DRAFT/PUBLISHED/ARCHIVED），含 assets。
- `apps/collab-api/src/modules/admin.controller.ts`：加 `@Get('releases')` + `@Query` channel（可选），`ensurePlatformAdmin`。
- `apps/collab-api/src/modules/release.service.spec.ts`：加 admin list 测试（返 DRAFT/ARCHIVED，channel 过滤）。

### B2. upload 接收 .sig（D1）

- `admin.controller.ts:316-326`：`FileInterceptor('file')` → `FileFieldsInterceptor({ file, signature? })`，`@UploadedFiles()`。
- `release.service.ts:215` `uploadAsset`：签名加 `sigFile?: { buffer?: Buffer; path?: string }`，有则读内容填 signature（`buffer.toString('utf-8')` 或 `readFileSync(path)`），**删除原 line 243-250「读同名 .sig」逻辑**（已由上传的 .sig 替代）。
- spec：补 upload 测试（传 file + signature → asset.signature 填入；只传 file → signature 空）。

**验证**：`pnpm -C apps/collab-api test -- release` 全过 + `pnpm -C apps/collab-api typecheck`。

## 前端新页面

### F1. 类型与导航

- `lib/types.ts`：`View` 联合加 `'releases'`；加 `ReleaseStatus = 'DRAFT'|'PUBLISHED'|'ARCHIVED'`，admin Release 类型（含 status）。
- `lib/navigation.ts`：「系统」分组加 `{ view: 'releases', label: '版本发布', icon: RocketIcon }`（lucide RocketIcon）。

### F2. api() 扩展 FormData + release 写封装

- `lib/api.ts`：`ApiOptions` 加 `formData?: FormData`；有 formData 时 body=formData、不设 Content-Type（浏览器加 boundary），其余复用。
- `lib/releases.ts` 加 admin 写封装：`listAdminReleases / createRelease / updateRelease / publishRelease / archiveRelease / addAsset / uploadAsset / deleteAsset`（调 `api()`，上传用 formData）。

### F3. releases-view.tsx 主页面

参考 plugins-view 结构：

- 顶部：channel 筛选（全部/STABLE/BETA）+「创建版本」按钮。
- Table 列：version / channel / title / status Badge / isLatest / asset 数 / publishedAt / 操作。
- DetailSheet：版本详情 + asset 列表（url 可复制 + 删除）+ 上传安装包区（platform/arch Select + .exe file input + 自动找同名 .sig + 上传按钮）+ 登记外链 asset 表单 + 编辑 title/notes。
- Dialog：创建版本（version semver + channel + title + notes）/ 发布确认 / 归档确认 / 删 asset 确认。
- 复用：`api` / `useLoad` / `useGuardedAction` / `Table` / `Dialog` / `DetailSheet` / `Pagination` / `Section` / `StatusBadge`。

### F4. App.tsx 路由

- lazy `ReleasesView` + `{view === 'releases' && <ReleasesView />}`。

## 验证命令

- 后端：`pnpm -C apps/collab-api test -- release` + `pnpm -C apps/collab-api typecheck`
- 前端：`pnpm -C apps/collab-admin typecheck` + `pnpm -C apps/collab-admin build`
- 端到端：admin 后台创建 v0.0.2 DRAFT → 上传 LingFang_0.0.2_x64-setup.exe + .sig → 发布 → 官网 DownloadPage 出现下载按钮 + 桌面端检查更新拿到版本

## 风险与回滚点

- B2 改 upload 签名：可能影响既有调用（无，仅此一处用）。回滚 = 还原 FileInterceptor。
- F2 改 api()：影响所有 api() 调用。风险低（仅加 formData 分支，无 formData 走原逻辑）。验证：typecheck + 现有页面回归。
- 风险点：FormData 上传大文件（.exe 3.7M）超时——api() 默认 timeout 需调大或上传单独不设 timeout。

## 实现顺序

1. B1（admin 列表端点）+ B2（upload .sig）→ 后端测试
2. F1（类型/导航）→ F2（api 封装）→ F4（路由骨架）
3. F3（releases-view 主页面）
4. 端到端验证（v0.0.2 上传 + 发布 + 下载）
