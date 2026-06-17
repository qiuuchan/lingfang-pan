# 技术设计：删除插件（本地目录 + 云端记录，分层）

## 架构与边界

三层改动：
- **Rust 本地删除**：plugin_runner.rs `delete_plugin` 命令（stop 进程 + remove_dir_all 目录）。
- **后端云端删除**：plugin.service 加 `deleteByAuthor` + admin.service 加 `adminDeletePlugin`；plugins.controller + admin.controller 加 DELETE 端点。
- **前端**：Plugins.tsx 本地删除按钮 + PluginList.tsx 作者云端删除按钮 + admin plugins-view admin 删除按钮。

## 本地删除：Rust delete_plugin（同前版设计）

放 plugin_runner.rs，复用 sanitize_plugin_id + kill_child_tree + store.plugin_dir：

```rust
#[tauri::command]
pub fn delete_plugin(
    store: tauri::State<'_, PluginStore>,
    process_table: tauri::State<'_, PluginProcessTable>,
    plugin_id: String,
) -> Result<(), String> {
    let id = sanitize_plugin_id(&plugin_id)?;
    if let Some((mut child, _)) = process_table.take(&id) {
        kill_child_tree(&child);
        let _ = child.kill();
        let _ = child.wait();
    }
    let dir = store.plugin_dir(&id)?;
    if !dir.exists() { return Ok(()); }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除插件目录失败：{e}"))
}
```

## 云端删除：后端

### 作者删（DELETE /api/plugins/:id）

`plugin.service.ts` 加 `deleteByAuthor(userId, id)`：
```ts
async deleteByAuthor(userId: string, id: string) {
  const plugin = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true, authorUserId: true, marketplace: true, name: true } });
  if (!plugin) throw notFound('插件不存在');
  if (plugin.authorUserId !== userId) throw forbidden('只能删除自己创建的插件');
  if (plugin.marketplace) throw conflict('已上架市场的插件需先联系管理员下架后再删除');
  // 级联删 Installation + Review（Cascade 自动）+ 物理删 Plugin。
  await this.prisma.plugin.delete({ where: { id } });
  await this.audit(userId, 'plugin.deleted', 'Plugin', id, { name: plugin.name });
}
```
plugins.controller 加 `@Delete(':id')` → `deleteByAuthor(requireUser(req).id, id)`。

### admin 删（DELETE /api/admin/plugins/:id）

`admin.service.ts` 加 `adminDeletePlugin(actorId, id)`：
```ts
async adminDeletePlugin(actorId: string, id: string) {
  await this.auth.ensurePlatformAdmin(actorId);
  const plugin = await this.prisma.plugin.findUnique({ where: { id }, select: { id: true, name: true, marketplace: true } });
  if (!plugin) throw notFound('插件不存在');
  // 级联删 Installation + Purchase + Review（Cascade 自动）+ 物理删 Plugin。
  await this.prisma.plugin.delete({ where: { id } });
  await this.audit(actorId, 'admin.plugin.deleted', 'Plugin', id, { name: plugin.name, wasMarketplace: plugin.marketplace });
}
```
admin.controller 加 `@Delete('plugins/:id')` → `adminDeletePlugin(requireUser(req).id, id)`。

**级联**：PluginInstallation / Purchase / PluginReview 都 `onDelete: Cascade`，Prisma `plugin.delete` 自动级联删，无需手动清。

## 前端

### 桌面 Plugins.tsx（本地删除）
本地插件（非 builtin）加「删除」按钮 → 二次确认 → deletePlugin(pluginId) → onRefresh。

### 桌面 PluginList.tsx（作者云端删除）
作者插件（source==='team'）加「删除」按钮：
- 二次确认（提示「云端记录 + 本地目录都将删除」）。
- 调 DELETE /api/plugins/:id。
- 成功后调 deletePlugin(pluginId) 清本地目录（若本地有）+ 刷新列表。
- 已上架（marketplace=true）后端返 conflict → toast「已上架，先联系管理员下架」。

### admin plugins-view（admin 删除）
插件行加「删除」按钮 → 二次确认（提示「级联删安装/购买记录，不可恢复」）→ DELETE /api/admin/plugins/:id → 刷新。

## 安全

- 本地：sanitize_plugin_id 防穿越，builtin 不在 plugins_root。
- 云端作者删：authorUserId 校验 + marketplace 拒绝（已上架先下架）。
- admin 删：ensurePlatformAdmin + 审计。
- 级联：Prisma Cascade 自动，无残留。

## 兼容性与回滚

- 全部新增端点/命令/按钮，不影响现有。回滚 = 删对应代码。
- 级联删 Purchase 是已确认接受的行为（admin 删已上架有购买的）。

## 风险点

- admin 删有购买的插件 → 购买记录级联消失，付费用户权益。已确认接受（admin 兜底，二次确认 + 审计）。
- 作者删团队内未上架插件 → 级联删同团队 Installation，团队成员本地插件失效。可接受（作者自己的资产）。
- remove_dir_all 删 venv 慢 → 可接受。
