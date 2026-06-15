# 审查缺陷全量修复 - 执行计划

## 执行顺序（6 批，每批修复后验证）

每批遵循：读相关文件 → 修复 → 本地验证（typecheck/test）→ 若绿则提交，否则回滚排查。

### 批次1：collab-api 鉴权与安全（P0/P1）

**P0 critical**
- [ ] PPK-01 付费墙绕过：`plugin.service.ts:131-147` installMarketplacePlugin 加付费校验（对照 marketplace.service.ts:94-97），抽取共享 ensurePurchased 辅助
- [ ] AUTH-01 refresh 续命：`auth.service.ts:63-89` sessionFor 加 `user.status !== 'ACTIVE'` 守卫
- [ ] ADMIN-02 不吊销 JWT：引入 token 版本号（user.tokenVersion），JwtAuthGuard 校验

**P1 系统性根因**
- [ ] XSEC-01 全局 ValidationPipe：main.ts 注册 useGlobalPipes(ValidationPipe whitelist+forbidNonWhitelist+transform)，各 controller @Body 改 DTO + class-validator 装饰器
- [ ] XERR-01 Prisma 错误映射：新增 PrismaExceptionFilter，P2002→409、P2025→404、PrismaClientValidationError→400，不回显 schema 信息

**其他**
- [ ] AUTH-03 register 非原子：user.create + application.create + audit 包进 $transaction
- [ ] AUTH-04 JWT_SECRET 启动期断言：main.ts bootstrap 检查，缺失则 fail-fast
- [ ] XSEC-02 CORS fail-close：未配置时不 reflect true
- [ ] XSEC-04 jwt.verify 加 algorithms 白名单
- [ ] XERR-02 logout no-op：至少记录（或引入 token 版本号随 ADMIN-02）
- [ ] XSEC-03 Swagger 生产关闭
- [ ] XCONTRACT-01 Swagger 版本号统一读 package.json

### 批次2：collab-api 经济与团队（P0/P1）

- [ ] TEAM-01 邀请码超发：redeemInvitation 改用事务内 updateMany where usedCount<maxUses + count!==1
- [ ] MKT-02 评分 TOCTOU：rate 改用事务内条件更新或乐观锁，聚合与明细对齐
- [ ] PLUGIN-02/MKT-05/PLUGIN-03/XLOG-02 installCount：统一用 existing 短路或条件 increment
- [ ] SCHEMA-01 signup_bonus 重复：ensureWallet 加 (userId,reason) 幂等校验
- [ ] SCHEMA-06 installCount schema 层（合并批次2 的 install 修复）
- [ ] TEAM-03 软删除团队未阻断：team.service 接口加 team.status 校验
- [ ] TEAM-02 submitApplication 并发：加 (userId,PENDING) 唯一约束
- [ ] ECO-01 并发购买 P2002→409
- [ ] MKT-04 sort=rating 改 avg_score
- [ ] 其余 medium/low（TEAM-04/05/06/08、MKT-03/06、PLUGIN-06/07）

### 批次3：collab-api 插件与管理（P1/P2）

- [ ] PLUGIN-04 editPluginDraft 守卫 APPROVED
- [ ] ADMIN-09 自禁用锁死：加自保护 + 末位管理员保护
- [ ] XLOG-01 adminUpdateTeam 字段白名单
- [ ] ADMIN-04/10/PLUGIN-05/09/ADMIN-06/07/10 各 P2025/P2002→正确状态码
- [ ] PPK-02 availablePlugins 不泄露 files（脱敏）
- [ ] PPK-03 priceCents 置 0
- [ ] PPK-04 Express body limit 提到 2MiB
- [ ] ADMIN-05/XSM-01 rejectApplication 状态机守卫
- [ ] ADMIN-08 setTeamAdmin 校验状态
- [ ] PLUGIN-08 availablePlugins 第4分支生命周期校验
- [ ] ADMIN-01 管理端 refresh 集成

### 批次4：desktop Rust（P0/P1）

- [ ] SCRIPT-01 plugin_id 清洗（sanitize_plugin_id 白名单）
- [ ] RT-01 iframe 去 allow-same-origin / 关 withGlobalTauri（按需）
- [ ] SCRIPT-02 超时杀进程组（CREATE_NEW_PROCESS_GROUP/setsid + kill -PGID）
- [ ] RUSTSHIM-01 store.rs 加 Mutex 或串行化 writer + write_json 原子 tmp+rename
- [ ] RUSTSHIM-02/SPAWN-01 send_input 运行态守卫
- [ ] SPAWN-02 stop_child_process Windows 杀进程树
- [ ] SPAWN-03 append_transcript 加锁
- [ ] RUSTSHIM-04 symlink 环检测
- [ ] CAP-01 fs.read 错误不回显 canonicalize 路径
- [ ] CAP-02 fs.read 大小上限
- [ ] CAP-04 NotDeclared 语义修正
- [ ] SCRIPT-03 probe 误判 Store stub
- [ ] SCRIPT-04 sandbox 清理
- [ ] SCRIPT-05 错误保留 CapError 语义
- [ ] RUSTSHIM-03/RUST-STREAM-03 并发（随 RUSTSHIM-01）
- [ ] SPAWN-04/05/06
- [ ] RUST-STREAM-01/04 build_history_summary 过滤 stream

### 批次5：desktop React（P1/P2）

- [ ] CREATOR-01 handleAskUserAnswer 复用 send 状态写入
- [ ] CREATOR-02 finalizeSession 加 activeId 守卫
- [ ] CREATOR-03~12 各状态/错误清理
- [ ] STREAM-01 单卡多问渲染
- [ ] ASKU-01 option 防抖
- [ ] ACCT-01/DESK-06 404 兜底
- [ ] DESK-SHELL-01~07 会话恢复
- [ ] DESK-01/03 api 超时 + 401 拦截
- [ ] DESK-TOKEN-01 token 失效统一处理
- [ ] DESK-MARKET-01/ONBOARD-01/REVIEW-01/AUTH-01/PLUGINS-01
- [ ] DRAFT-01~06 草稿协议
- [ ] RT-03/05/07/08 运行态桥
- [ ] CREATOR-13/DRAFT-05/06 dead code

### 批次6：collab-admin + packages（P2/P3）

- [ ] ADMIN-VIEW-01 资金调整防抖 + loading
- [ ] ADMIN-VIEW-04 表单提交失败不关弹窗
- [ ] ADMIN-VIEW-02/03/06/07/08
- [ ] CONTRACT-02/03/04/06/07/08/09 契约对齐
- [ ] SDK-01/02/04/05/06/08
- [ ] SDK-07（孤儿 schema）
- [ ] CAP-07 正向测试

## 验证

每批后：
```bash
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
pnpm -C apps/desktop typecheck
pnpm -C apps/collab-admin build
cd apps/desktop/src-tauri && cargo test
```

全部完成后：code review（trellis-check 或 superpowers:code-reviewer）。

## 提交策略

每批一个 commit，message 格式：`fix(<scope>): <批次描述>`，body 列出本批修复的缺陷 ID。
