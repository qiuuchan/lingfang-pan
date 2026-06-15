# 执行计划：Gitee 更新日志接入 + 密钥配置

> 设计依据：`design.md`（本目录）。子任务上下文加载顺序：implement.jsonl → prd.md → design.md → 本文件。

## 执行清单（按依赖顺序，每步可独立验证）

### 后端（先做，前端依赖契约）

- [ ] **B1. 新增 DTO** `apps/collab-api/src/modules/dto/changelog.dto.ts`
  - 导出 `ChangelogEntry`、`ChangelogResponse` 接口（见 design.md §三）。
  - 仅出参契约，无 class-validator 装饰器（公开端点无 body 入参）。
  - **验证**：`pnpm -C apps/collab-api typecheck` 通过。

- [ ] **B2. 新增 GiteeChangelogService** `apps/collab-api/src/modules/gitee-changelog.service.ts`
  - 常量：`GITEE_API_BASE` / `DEFAULT_GITEE_OWNER` / `DEFAULT_GITEE_REPO` / `GITEE_TIMEOUT_MS=8_000` / `GITEE_CACHE_TTL_MS=600_000`。
  - 实例字段：`changelogCache` / `inflight`。
  - 方法：`getChangelog()` / `invalidateChangelogCache()` / `fetchWithCache()` / `doFetch()` / `loadGiteeConfig()` / `mapGiteeRelease()`。
  - 文件头注释标注单实例缓存约束。
  - **验证**：`pnpm -C apps/collab-api typecheck` 通过。

- [ ] **B3. 新增 ChangelogController** `apps/collab-api/src/modules/changelog.controller.ts`
  - `@ApiTags('Changelog')` `@Controller('changelog')`，`@Public()` `@Get()` 方法级装饰器。
  - 注入 GiteeChangelogService，调 `getChangelog()` 直接返回。
  - **验证**：`pnpm -C apps/collab-api typecheck` 通过。

- [ ] **B4. Module 注册** `apps/collab-api/src/modules/collab.module.ts`
  - providers 数组加 `GiteeChangelogService`。
  - controllers 数组加 `ChangelogController`。
  - **验证**：`pnpm -C apps/collab-api typecheck` + 启动 dev 不报 DI 错误。

- [ ] **B5. settings.service.ts 改动**（5 处）
  - `KEY_VALIDATORS` 追加 `giteeOwner` / `giteeRepo`（共享 `validateRepoSegment`）/ `giteeAccessToken`。
  - module 顶层新增 `validateRepoSegment` 函数 + `SECRET_KEYS` 集合。
  - 构造函数追加 `@Inject(GiteeChangelogService) private readonly gitee`。
  - 新增常量 `GITEE_CACHE_KEYS = new Set(['giteeOwner', 'giteeRepo', 'giteeAccessToken'])`。
  - `updateSettings`：审计循环内对 SECRET_KEYS 命中 key 改记 `{key, configured}`；末尾追加 `if (normalized.some(GITEE_CACHE_KEYS.has)) this.gitee.invalidateChangelogCache()`。
  - 新增 `getGiteeSettings(userId)`（脱敏 hasAccessToken）+ `testGitee(actorId)`（探测 releases 端点）。
  - **验证**：`pnpm -C apps/collab-api typecheck` 通过。

- [ ] **B6. admin.controller.ts 改动**
  - `GET settings/gitee` → 调 `this.settings.getGiteeSettings(requireUser(req).id)`。
  - `POST settings/test-gitee` → 调 `this.settings.testGitee(requireUser(req).id)`。
  - 仿现有 geetest 两端点装饰器范式。
  - **验证**：`pnpm -C apps/collab-api typecheck` 通过。

- [ ] **B7. 单元测试** `apps/collab-api/src/modules/gitee-changelog.service.spec.ts`（新建）
  - mock `globalThis.fetch`（照搬 settings.service.spec.ts:330-343 模式）。
  - 用例：unconfigured / 成功 / 401（吐缓存不清缓存）/ 429（不清缓存）/ 网络异常 / 缓存命中不重复 fetch / invalidateChangelogCache 后回源。
  - **验证**：`pnpm -C apps/collab-api test gitee-changelog` 全绿。

- [ ] **B8. settings.service.spec.ts 追加用例**
  - giteeOwner/giteeRepo/giteeAccessToken 白名单 + 格式校验（合法/非法各一，含 `../foo` 拒绝）。
  - getGiteeSettings token 脱敏（`expect(JSON.stringify(result)).not.toContain(token明文)`）。
  - testGitee 状态映射（200/401/403/404/网络）。
  - 改 gitee key 失效 `gitee.invalidateChangelogCache`。
  - updateSettings 对 giteeAccessToken 审计不记明文（断言 metadata 无 token 字符串）。
  - **验证**：`pnpm -C apps/collab-api test settings` 全绿。

### 前端（后端契约就绪后）

- [ ] **F1. releases.ts 追加** `apps/collab-admin/src/lib/releases.ts`
  - `ChangelogEntry` / `ChangelogResponse` 接口（对齐后端出参）。
  - `listChangelog(): Promise<ChangelogResponse>`（复用 `fetchPublic`）。
  - **不动** `Release` / `ReleaseAsset` / `getLatestRelease` / `listReleases`。
  - **验证**：`pnpm -C apps/collab-admin typecheck` 通过。

- [ ] **F2. ChangelogPage.tsx 改造** `apps/collab-admin/src/components/landing/ChangelogPage.tsx`
  - import 改 `listChangelog`，state 从 `Release[]` 改 `ChangelogEntry[]` + `degraded`/`message`。
  - useEffect 调 `listChangelog()`，取 `.releases` 填 state、`.degraded`/`.message` 填横幅状态。
  - 顶部加降级横幅（degraded=true 时橙色边框卡片显示 message）。
  - 升级 `renderNotes`（支持 #/##/###、图片、链接、缩进列表、---、保留空行，见 design.md §八）。
  - **验证**：`pnpm -C apps/collab-admin typecheck` 通过。

- [ ] **F3. settings-view.tsx 新增 Gitee 卡片** `apps/collab-admin/src/components/settings-view.tsx`
  - state：`gitee`/`giteeDraft`（含 hasAccessToken）/`giteeAccessTokenDraft`/`giteeLoading`/`giteeSaving`/`giteeTesting`。
  - useEffect 加载 GET settings/gitee（与 SMTP/geetest 并列）。
  - 卡片结构复刻极验卡片：owner/repo 明文 Input + accessToken password Input + 保存按钮 + 测试连通性按钮 + 状态 Badge。
  - saveGiteeSettings：owner/repo 始终提交，accessToken 仅 length>0 提交。
  - testGitee：改了未保存时提示先保存。
  - 说明文案（design.md §九）。
  - **验证**：`pnpm -C apps/collab-admin typecheck` 通过。

## 验证门（review gate）

- [ ] `pnpm -C apps/collab-api typecheck` 通过。
- [ ] `pnpm -C apps/collab-admin typecheck` 通过。
- [ ] `pnpm -C apps/collab-api test` 全绿（含 B7/B8 新增用例）。
- [ ] `pnpm -C apps/collab-admin build` 通过。
- [ ] 手动冒烟：启动 collab-api + collab-admin，管理端设置页填 Gitee 配置 → 测试连通性 → 落地页更新日志页渲染 Gitee release。

## 风险点

1. **Gitee asset 的 name/size 字段未完整建模**：SDK 未覆盖，后端不返回 size（前端不展示文件大小）。上线前可用真实 token curl 一次确认 asset 完整字段。
2. **rate limit 数值未公开**：10min 缓存 + singleflight 兜底，若实际限流更严需调短 TTL。
3. **renderNotes 升级正则复杂度**：需覆盖图片在链接前匹配的顺序坑（`!\[` 必须在 `\[` 前判断）。
4. **ChangelogPage 类型从 Release[] 改 ChangelogEntry[]**：渲染字段（id/version/title/notes/publishedAt/isLatest）完全一致，零 JSX 改动，仅类型注解 + 降级横幅。
