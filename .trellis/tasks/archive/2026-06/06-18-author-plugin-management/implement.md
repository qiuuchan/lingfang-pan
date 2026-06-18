# 作者侧插件管理 — 执行计划

## 前置阅读（实现前确认）

- `apps/collab-api/src/modules/plugin.service.ts:176-216`（editPluginDraft 模式，照搬鉴权/审计骨架）
- `apps/collab-api/src/modules/plugin-package.ts`（normalizePluginPackage 的 name/description 长度上限，对齐 DTO MaxLength）
- `apps/collab-api/src/modules/dto/plugins.dto.ts`（DTO 风格）
- `apps/desktop/src/pages/PluginList.tsx`（待抽取的三个对话框组件）
- `apps/desktop/src/lib/types.ts:123-148`（LoadedPlugin / View）
- `apps/desktop/src/App.tsx` 路由 switch、`apps/desktop/src/components/Sidebar.tsx` 入口

## 实现步骤

### 后端（collab-api）

1. **DTO**：在 `dto/plugins.dto.ts` 增 `EditPluginMetaDto`（name/description/icon 三个可选字段 + MaxLength，icon 上限常量）。
   - 验证命令：`pnpm --filter @lingfang/collab-api build`
2. **Service**：在 `plugin.service.ts` 增 `editPluginMeta()`，按 design §1.1 逻辑实现（鉴权、PENDING 拦截、已上架允许改元数据并注释理由、manifest 浅合并、审计 `plugin.meta.edited`）。
3. **Controller**：在 `plugins.controller.ts` 增 `POST :id/edit-meta` 端点。
4. **后端验证**：
   - `pnpm --filter @lingfang/collab-api build`（tsc 通过）
   - 若有 e2e/单测框架，补一条 editPluginMeta 的最小测试（改名成功 / PENDING 拦截 / 非作者拒绝）；无则在 check 阶段用手动调用验证并记录。

### 前端（desktop）

5. **抽取共享作者操作组件**：将 `PluginPriceEditDialog`、`PluginStatusToggle`、`PluginDeleteDialog` 从 `PluginList.tsx` 提取到 `apps/desktop/src/components/plugins/author-actions.tsx` 并导出；`PluginList.tsx` 改为 import 使用（等价重构，行为不变）。
6. **新增 `PluginMetaEditDialog`**（放入 author-actions.tsx）：名称 Input + 描述 Textarea + 图标（emoji Input + 本地选图→base64+大小校验，拒绝 svg）。保存 `POST /api/plugins/:id/edit-meta`。
7. **新增 `PluginSubmitDialog`**：提交上架 `POST /api/plugins/:id/submit-marketplace`（可带 priceCents），审核流程说明文案。
8. **类型**：`types.ts` 给 `View` 加 `'author-center'`；必要时给 manifest 类型补 `icon?: string`。
9. **AuthorCenter 页面**（`apps/desktop/src/pages/AuthorCenter.tsx`）：
   - `GET /api/plugins/mine` 首载 + 手动刷新按钮（RefreshCwIcon）。
   - 列表项：图标（manifest.icon / 占位）+ 名称 + Badge（审核态/价格/启停）+ 操作区（编辑元数据 / 改价 / 启停 / 提交上架 / 删除）。
   - 空态提示「还没有发布的插件」。
10. **路由与入口**：`App.tsx` switch 加 `author-center` 分支渲染 `<AuthorCenter />`；`Sidebar.tsx` 加入口项（lucide 图标 + 「作者中心」）。
11. **前端验证**：
    - `pnpm --filter @lingfang/desktop build`（tsc + vite 构建通过）
    - `pnpm --filter @lingfang/desktop lint`（若存在）

## 验证命令汇总

```powershell
pnpm --filter @lingfang/collab-api build
pnpm --filter @lingfang/desktop build
```

## 手动冒烟（check 阶段）

1. 启动平台（参考既有 pnpm start 编排），登录有团队的账号。
2. 上传/已有一个 team 来源插件 → 进入「作者中心」，列表展示该插件。
3. 编辑元数据：改名称/描述、设置 emoji 图标与上传一张小图 → 保存 → 列表与插件页名称/图标更新，审核态未被打回。
4. PENDING 态插件编辑 → 后端返回 conflict 文案，前端 toast 提示。
5. 提交上架 → reviewStatus 变 PENDING。
6. 改价 / 启停 / 删除沿用既有行为，回归插件页（PluginList）三项操作仍正常（验证抽取无回归）。

## 审查门（review gates）

- 后端 build 通过 + editPluginMeta 不影响 editPluginDraft 行为（两方法独立）。
- 前端 build 通过 + PluginList 既有改价/启停/删除回归正常（共享组件抽取等价）。
- 图标不接受 svg+xml；base64 超限被拒。

## 回滚点

- 后端：删除 EditPluginMetaDto / editPluginMeta / edit-meta 端点（纯新增，无迁移）。
- 前端：移除 author-center View 分支与 AuthorCenter 页面、还原 author-actions.tsx 抽取（git revert 该提交）。

## 与其他子任务的协调

- **06-18-plugin-status-refresh**：作者中心的刷新按钮与云端插件列表刷新是同类需求，复用同一 RefreshCwIcon 交互风格；若两任务并行，注意 PluginList 改动不冲突。
- **06-18-fix-plugin-iframe-click**：作者中心若用 Dialog，受益于该任务对 dialog.tsx 的 pointer-events 修复。
