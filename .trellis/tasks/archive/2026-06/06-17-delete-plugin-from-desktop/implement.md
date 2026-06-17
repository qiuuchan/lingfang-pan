# 执行计划：删除插件（本地 + 云端分层）

## 步骤 1：Rust 本地 delete_plugin

- `plugin_runner.rs`：新增 `delete_plugin`（sanitize → take+kill 进程 → remove_dir_all）。
- `main.rs`：generate_handler 注册。
- 单测：删目录/幂等/sanitize 拒穿越/运行中先 stop。

## 步骤 2：后端云端删除

- `plugin.service.ts`：加 `deleteByAuthor(userId, id)`（作者校验 + marketplace 拒绝 + 审计 + delete）。
- `admin.service.ts`：加 `adminDeletePlugin(actorId, id)`（ensurePlatformAdmin + 审计 + delete）。
- `plugins.controller.ts`：加 `@Delete(':id')` → deleteByAuthor。
- `admin.controller.ts`：加 `@Delete('plugins/:id')` → adminDeletePlugin。
- 单测：作者删（鉴权/已上架拒绝/级联）、admin 删（级联 Installation+Purchase）。

## 步骤 3：前端

- `plugin-status.ts`：加 `deletePlugin(pluginId)`（tauriInvoke）。
- `Plugins.tsx`：本地插件（非 builtin）加删除按钮 + 二次确认 → deletePlugin → onRefresh。
- `PluginList.tsx`：作者插件（source==='team'）加删除按钮 → DELETE /api/plugins/:id → 成功后 deletePlugin 清本地 + 刷新；已上架 conflict toast。
- `apps/collab-admin/src/components/plugins-view.tsx`：加删除按钮 → DELETE /api/admin/plugins/:id → 刷新。

## 验证命令

- Rust：`cargo test -p lingfang-desktop`
- 后端：`pnpm -C apps/collab-api test`（plugin/admin service 测试）
- 前端：`pnpm -C apps/desktop typecheck` + `pnpm -C apps/collab-admin typecheck`
- 手动：本地删 temp/正式/运行中/builtin；作者删未上架云端+本地；作者删已上架被拒；admin 删有购买+级联。

## 实现顺序

1. 步骤 1（Rust 本地删）+ 单测 → cargo test
2. 步骤 2（后端云端删）+ 单测 → 后端 test
3. 步骤 3（前端三处按钮）→ typecheck
4. 手动验证全场景

## 风险与回滚点

- 级联删 Purchase（admin 删已上架）→ 已确认接受，二次确认 + 审计。
- sanitize 防穿越 → 白名单。
- 进程占用 → take+kill+wait。
- 回滚 = 删对应命令/端点/按钮。
