# 管理深度完善（插件团队用户管理员审计性能review）

## Goal

7 项深度完善：插件管理（编辑信息等）+ 团队管理 + 用户管理 + 平台管理员管理 + 审计（更多日志/分类/说明）+ 性能优化 + 全代码 review 按优先级修复。

## 范围

### 1. 插件管理完善（admin plugins-view + 后端）
- admin 编辑插件信息：name/description/version/priceCents/visibility（PATCH /api/admin/plugins/:id 扩展字段）。
- 插件下架（marketplace=false + 状态重置，已有 adminUpdatePlugin status，补 marketplace 下架动作）。
- 版本管理（插件多版本，当前单版本——首版加 version 展示 + 历史，或留 TODO）。
- 详情抽屉已有（组D 之前加），完善：文件预览 + capabilities + 审核历史时间线。

### 2. 团队管理完善（admin teams-view + 后端）
- 成员管理：查看团队成员列表 + 角色升级/降级（TEAM_ADMIN↔MEMBER）。
- 团队配额/余额管理（已有 balance-adjustments，完善 UI）。
- 团队详情：成员活跃度 + 插件数 + 购买记录。
- 团队启用/停用（status ACTIVE/SUSPENDED）。

### 3. 用户管理完善（admin users-view + 后端）
- 用户详情：登录历史 + 操作记录 + 钱包 + 团队。
- 用户启用/停用（status ACTIVE/DISABLED，已有 adminUpdateUser）。
- 重置用户密码（admin 强制重置）。
- 用户搜索/筛选（已有，完善）。

### 4. 平台管理员管理完善（admin admins-view + 后端）
- 管理员列表 + 授权/撤销（platformRole NONE↔PLATFORM_ADMIN）。
- 管理员操作记录（按 actorUserId 查审计）。
- 创建管理员（已有 adminCreateUser，完善角色分配）。

### 5. 审计完善（audit-view + 后端）
- **更多日志**：补全当前缺失的审计点（用户登录/登出、插件安装/卸载、团队创建/删除、配置变更等）。
- **分类**：审计 action 按模块分类（auth/team/plugin/marketplace/wallet/llm/admin/system），audit-view 加分类筛选。
- **详细说明**：每条审计 action 有人类可读的描述（action → 中文说明映射），而非裸字符串。
- 审计详情展开（metadata 完整展示，而非只看 action）。
- 审计导出（可选 CSV/JSON）。

### 6. 性能优化
- **数据库查询**：检查 N+1 查询（列表 + include 关联）、补缺失索引、大表分页优化。
- **后端**：响应缓存（热点数据如 active-provider/platform-info）、查询 select 精简（不返敏感字段）。
- **前端**：列表虚拟滚动（大列表）、防抖搜索、分页（已有，确认）。
- **桌面**：vite 分包已做，检查重计算优化。

### 7. 全代码 review（按优先级修复）
- 多 agent 并行按模块 review（后端/桌面Rust/桌面前端/admin）。
- 找 blocker/high 修复，medium/low 记录。
- **最后做**（在 1-6 完成后，review 最终代码）。

## Constraints

- 简体中文。UTF-8 无 BOM。
- 复用现有端点/组件，增量完善。
- 审计 action 分类用前缀（auth./team./plugin./marketplace./wallet./llm./admin./system.）。
- 性能优化不破坏功能（索引迁移非破坏式）。
- review 最后做。

## AC

- [ ] AC1 admin 能编辑插件信息（name/desc/price/visibility）+ 下架。
- [ ] AC2 admin 团队管理能看成员 + 改角色 + 停用团队。
- [ ] AC3 admin 用户管理能看详情 + 停用 + 重置密码。
- [ ] AC4 admin 管理员管理能授权/撤销 + 看操作记录。
- [ ] AC5 审计补全缺失日志点 + 分类筛选 + 中文说明 + 详情展开。
- [ ] AC6 性能优化（索引/查询/缓存，可量化或可说明改善）。
- [ ] AC7 全 review 完成，blocker/high 修复，medium/low 记录。
- [ ] AC8 全量验证绿（test/typecheck/build 不回归）。
