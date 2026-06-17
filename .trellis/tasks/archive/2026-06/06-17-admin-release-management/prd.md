# admin 版本发布管理页（上传安装包+下载链接）

## Goal

在 admin 后台新增「版本发布」管理页，让平台 Admin 通过 UI 创建版本、上传安装包（自动生成 `/downloads/` 下载链接 + 读取 .sig 签名）、发布/归档版本、登记外链产物。解决当前「后端 release API 齐全但 admin 前端无管理入口、无法上传安装包生成下载链接」的缺口。

发布后，官网下载页（DownloadPage）与 Tauri updater（`/api/releases/tauri-update`）即可拿到带下载链接的版本，用户能下载安装、应用内能检查更新。

## 已确认事实（来自代码查证）

- **后端 admin release API 完整**（`apps/collab-api/src/modules/admin.controller.ts` + `release.service.ts`）：
  - `POST /api/admin/releases` — 创建 DRAFT 版本（version/channel/title/notes，version+channel 唯一）
  - `PATCH /api/admin/releases/:id` — 改 title/notes
  - `POST /api/admin/releases/:id/publish` — 发布（事务维护 isLatest 唯一 + 落 publishedAt）
  - `POST /api/admin/releases/:id/archive` — 归档
  - `POST /api/admin/releases/:id/assets` — 登记外链 asset（platform/arch/url/filename/signature/sizeBytes）
  - `POST /api/admin/releases/:id/assets/upload` — **上传安装包文件**到 `downloads/`，自动建 asset（url=`/downloads/<随机前缀文件名>`，同名 `.sig` 自动读取填入 signature）
  - `DELETE /api/admin/releases/:id/assets/:assetId` — 删 asset
  - 写操作均 `ensurePlatformAdmin`，审计落 `admin.release.*`
- **DTO 契约**（`dto/release.dto.ts`）：ReleaseCreateDto（semver version + channel + title + notes）、ReleaseAssetCreateDto（platform∈WINDOWS/DARWIN/LINUX、arch∈X86_64/AARCH64/UNIVERSAL、url、filename、signature、sizeBytes）。
- **admin 前端导航单一数据源** `lib/navigation.ts`（NAV_GROUPS 三组 8 view），新 view 加这里 + App.tsx 路由 + lazy 组件即可。
- **admin 前端无 release 写操作封装**：`lib/releases.ts` 只有公开读（getLatestRelease/listReleases），`lib/api.ts` 无 release 写方法。需新增 admin 写 API 封装。
- **官网 DownloadPage** 已用 `getLatestRelease` 展示下载按钮（资产 url），发布后自动生效。
- **v0.0.2 安装包**在 `target/release/bundle/nsis/LingFang_0.0.2_x64-setup.exe` + `.sig`（2026-06-17 构建，已验证）。首发可手动上传该包。

## Requirements

- R1 新增导航项「版本发布」（releases view），归入「系统」分组，与现有 8 view 同模式。
- R2 版本列表：展示所有版本（version/channel/title/status/isLatest/publishedAt/asset 数），支持按 channel（STABLE/BETA）筛选，分页。
- R3 创建版本：Dialog 表单（version semver 校验 + channel + title + notes markdown），创建为 DRAFT。
- R4 上传安装包：在版本详情里选 platform + arch + 上传 .exe 文件（multipart），调 `/assets/upload`，后端自动落 `downloads/` + 生成 `/downloads/<file>` 下载链接 + 读同名 .sig 填 signature。上传后列表回显下载链接（可复制）。
- R5 登记外链产物：除上传外，支持手动填外链 url（platform/arch/url/filename/signature/sizeBytes），调 `/assets`。覆盖「安装包托管在第三方（如 GitHub Release）」场景。
- R6 发布/归档：DRAFT → 发布（publish）；PUBLISHED → 归档（archive）。操作前二次确认。
- R7 编辑：DRAFT 可改 title/notes；PUBLISHED 仅改 title/notes（后端约束）。
- R8 删除 asset：详情里删单个产物（二次确认）。
- R9 复用现有 UI 组件模式（Table/Dialog/DetailSheet/Pagination/Section/StatusBadge），与 plugins-view 风格一致。

## Acceptance Criteria

- [ ] 侧栏出现「版本发布」入口，点击进入版本列表页。
- [ ] 能创建一个 v0.0.2 的 DRAFT 版本（version=0.0.2, channel=STABLE, notes=更新说明）。
- [ ] 能上传 `LingFang_0.0.2_x64-setup.exe`（选 WINDOWS + X86_64），上传成功后列表显示该 asset + 下载链接 `/downloads/<file>` + signature 已填。
- [ ] 发布该版本后，官网 DownloadPage 出现 v0.0.2 下载按钮且可下载；桌面端检查更新能拿到该版本（updater 契约 url 指向 `/downloads/<file>`）。
- [ ] 支持登记外链 asset（手动填 url）。
- [ ] 支持归档已发布版本；归档后官网不再展示为最新。
- [ ] 支持删除 asset、编辑 DRAFT 的 title/notes。
- [ ] typecheck 通过；不破坏现有 admin 页面与公开 release 端点。

## Out of Scope

- macOS/Linux 安装包上传（后端支持，前端按平台枚举可选，但首发只传 Windows）。
- 批量上传/批量发布。
- 版本回滚到 DRAFT（后端无此 API，归档替代）。
- 下载统计/下载数计数（后端无此字段）。

## Notes

- 复杂任务，需 design.md + implement.md。
- 后端零改动（API 齐全），纯 admin 前端新页面 + API 封装。
- 上传走 multipart/form-data，复用 `api()` 但需适配 FormData（现有 api() 若只支持 JSON body 需扩展）。
- 首发验证用 v0.0.2 安装包（已在 target/）。
