# 删除插件（本地目录 + 云端记录，分层）

## Goal

支持删除插件，分本地与云端两层：
- **本地删除**：桌面端删 `plugins_root/<plugin_id>/` 目录（temp 草稿 + 本地正式插件）。
- **云端删除**：作者删自己未上架的插件；admin 删任意插件（含已上架）。

## 范围边界（分层治理）

**本地删除**（桌面端 Rust delete_plugin）：删 `plugins_root/<id>/` 目录。不删云端记录。builtin 不删。

**云端删除**（后端 DELETE 端点）：
- **作者删**（DELETE /api/plugins/:id）：仅删自己的 + 仅未上架市场（marketplace=false，即草稿/驳回/团队内未上架）。已上架必须先 admin 下架（delist）再删。级联删 PluginInstallation（安装记录）。
- **admin 删**（DELETE /api/admin/plugins/:id）：删任意插件（含已上架），二次确认 + 审计。级联删 PluginInstallation + Purchase。
- 已上架 + 有 Purchase 的：admin 可删（兜底，物理删级联清购买记录——已确认接受）；作者不能删（先下架）。

**不删**：builtin 内置插件。已安装市场插件的「卸载」单独概念（不在此任务）。

## 已确认事实（来自代码查证）

- **Rust plugin_store**（`plugin_store.rs`）：有 `list_plugins`/`read_plugin_file`/`rename_plugin_dir`/`scan_plugin_status`/`ensure_plugin_dir`，**无 delete 命令**。`plugin_dir(plugin_id)` 返回目录路径，`sanitize_plugin_id` 段级白名单防穿越。
- **Plugins.tsx**：展示本地扫描插件（scanPluginStatus），有运行/停止/查看 manifest，**无删除按钮**。
- **后端 plugins.controller**：无 DELETE 端点。作者无删除能力。
- **后端 admin.controller**：有 `delistPlugin`（下架：marketplace=false + reviewStatus=DRAFT + 通知作者），**无物理删除**。已有 adminDeleteUser/adminDeleteTeam 模式可参考。
- **Plugin 表关联**：PluginInstallation（安装）+ Purchase（购买）+ PluginReview（审核）均 `onDelete: Cascade`——删 Plugin 级联删这些记录。
- **治理约束**（plugin.service）：已上架（marketplace=true）插件作者不可改价/禁用/编辑，需 admin 下架。删除沿用此约束：作者删仅限未上架。
- **进程表**（PluginProcessTable）：删除本地运行中插件前需先 stop（杀进程）再删目录。
- **PluginList.tsx**：作者插件（source==='team'）展示，有改价按钮，可加删除按钮。
- **admin plugins-view**：有编辑/审核历史/下架，可加删除按钮。

## Requirements

### 本地删除（Rust）

- R1 Rust 加 `delete_plugin` 命令：`sanitize_plugin_id` 校验 → 若进程表在运行先 stop → `remove_dir_all(plugin_dir)`。
- R2 安全：plugin_id 白名单防穿越；只删 `plugins_root/<plugin_id>/`；builtin 不在 plugins_root 不受影响。
- R3 前端 Plugins.tsx 本地插件（非 builtin）加「删除」按钮 + 二次确认 → delete_plugin → 刷新。

### 云端删除（后端 + 前端）

- R4 后端加 `DELETE /api/plugins/:id`（作者删自己）：鉴权作者 = authorUserId → 仅 marketplace=false 可删（已上架抛 conflict「先联系管理员下架」）→ 级联删 Installation → 物理删 Plugin。
- R5 后端加 `DELETE /api/admin/plugins/:id`（admin 删任意）：ensurePlatformAdmin → 级联删 Installation + Purchase + Review → 物理删 Plugin + 审计 `admin.plugin.deleted`。
- R6 桌面端 PluginList.tsx 作者插件（source==='team'）加「删除」按钮：未上架可直接删；已上架提示「先联系管理员下架」。二次确认（提示云端记录 + 本地目录都删）。
- R7 admin plugins-view 加「删除」按钮（admin 删任意）：二次确认（提示级联删安装/购买记录）→ DELETE /api/admin/plugins/:id。
- R8 删除云端插件后同步删本地目录（若本地有）：前端删云端成功后调 delete_plugin 清本地。
- R9 单测：Rust delete_plugin（删目录/幂等/sanitize 拒穿越/运行中先 stop）；后端作者删（鉴权/已上架拒绝/级联）、admin 删（级联 Installation+Purchase）。

## Acceptance Criteria

- [ ] 桌面 Plugins 页本地插件（非 builtin）有「删除」按钮 → 删本地目录。
- [ ] 桌面 PluginList 作者插件有「删除」按钮 → 未上架删云端+本地；已上架提示先下架。
- [ ] admin plugins-view 有「删除」按钮 → 删任意插件（含已上架）+ 级联清记录 + 审计。
- [ ] 删除运行中的本地插件 → 先 stop 再删。
- [ ] 作者删未上架插件 → 级联删安装记录，Plugin 物理删。
- [ ] 作者删已上架插件 → 被拒（conflict）。
- [ ] admin 删有购买的插件 → 级联删 Purchase + Installation，Plugin 删，审计落。
- [ ] builtin 无删除按钮；plugin_id 穿越（`../`）被拒。
- [ ] cargo test + 后端 test + 前端 typecheck 通过。

## Out of Scope

- 云端插件记录删除（后端无 API + 治理约束）。
- 已安装市场插件的卸载（后端无 uninstall API）。
- 批量删除。

## Notes

- 复杂任务，需 design.md + implement.md。
- 改 Rust（plugin_store delete_plugin + 进程表 stop 联动）+ 前端（Plugins.tsx 删除按钮 + 二次确认）。
- 参考现有 stop_plugin / rename_plugin_dir 的 sanitize + 进程表模式。
