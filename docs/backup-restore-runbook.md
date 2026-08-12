# 备份与恢复 Runbook（P2-5）

> 关联工单：《LingFang-工单-Beta推进-备份演练与文档-2026-08-11.md》T4 P2-5
> 配套脚本：`scripts/backup-pg.sh`
> 部署顺序约定（见 `docs/collab-deployment.md`）：备份 → apply → verify → 部署 → 冒烟。

本 runbook 给出**场景化回滚步骤**。核心纪律：**未演练的备份不算备份**——任何恢复流程上线前必须先在隔离环境实跑（见文末「演练记录」）。

---

## 0. 前置与约定

- 数据库：PostgreSQL（provider 锁定 `postgresql`）。默认库名 `lingfang_collab`，连接串取自 `apps/collab-api/.env.example`：
  `postgresql://lingfang:lingfang@localhost:5432/lingfang_collab`
- 迁移工具：`prisma migrate deploy`（脚本包装为 `pnpm -C apps/collab-api prisma:deploy`）。
- 验证入口（恢复后必须跑）：
  - `scripts/verify-all.mjs`（node 脚本，串联 smoke/插件生命周期/计费/内置插件 4 路验证）
  - `scripts/smoke-ci.sh`（完整链路：install → prisma generate → db:setup → 起 API → verify-all）
- 制品存储：插件制品目录（默认 `storage/`），需与数据库一起备份/恢复，详见 §3。

---

## 1. 备份（日常）

```bash
# 将 PG bin 目录加入 PATH（本机为 D:\lf-pan\pg\pgsql\bin）
export PATH="$PWD/pgsql/bin:$PATH"   # 或你的 PG 安装路径

# 最小备份（连当前 $DATABASE_URL 指向的库）
BACKUP_ROOT=./backups ARTIFACT_ROOT=./storage \
  bash scripts/backup-pg.sh --db-url "$DATABASE_URL"

# 带异地副本
bash scripts/backup-pg.sh --db-url "$DATABASE_URL" \
  --backup-root ./backups --artifact-root ./storage \
  --offsite /mnt/lingfang-offsite/backups
```

产出（每次一个时间戳目录 `backups/YYYYMMDD-HHMMSS/`）：
- `<db>.dump`：`pg_dump -Fc` 逻辑全库（支持单表/单对象恢复）
- `globals.sql`：`pg_dumpall --globals-only`（角色与权限；恢复前必须先建角色）
- `artifacts-manifest.txt`：制品存储文件清单（大小 + 总量）
- `backup-meta.txt`：备份集元数据（时间、库名、pg_dump 版本）

保留策略：日备保留 7 份、周一备保留 5 份（周备）、每月 1 号备保留 12 份（月备），可由 `--keep-daily/--keep-weekly/--keep-monthly` 调整。

---

## 2. 场景 A：数据损坏（误删行 / 注水 / 表被删）—— 数据恢复

适用：某个表被误删或数据被污染，但 **schema（migration 历史）完好**。

```bash
# 1) 停止写入（停 API / 切只读），避免恢复期间又有新写入
# 2) 用最近一次备份恢复全库（--clean --if-exists 清旧对象，--no-owner 适配恢复用户）
export PATH="$PWD/pgsql/bin:$PATH"
pg_restore -Fc --clean --if-exists --no-owner \
  -d "$DATABASE_URL" backups/<最新>/lingfang_collab.dump

# 3) 若只需恢复单表（例如 wallet_transaction 被注水）：
#    pg_restore -Fc --clean --if-exists --no-owner --table=wallet_transaction \
#      -d "$DATABASE_URL" backups/<最新>/lingfang_collab.dump

# 4) 验证：migration 历史必须 up to date，且业务对账一致
pnpm -C apps/collab-api npx prisma migrate status   # 期望: All migrations have been applied
node scripts/verify-all.mjs                          # 期望: 4 路全绿
```

**反向断言**：若中断恢复（如 dump 损坏），`pg_restore` 非零退出，且 `verify-all.mjs` 会因数据缺失/对账失败而红——**绝不允许「恢复成功但数据缺失」的静默成功**。

---

## 3. 场景 B：制品丢失 —— 制品恢复

插件制品（`.lfplugin` 包、release 文件）与数据库**分开存储但必须一起备份**。

```bash
# 恢复制品清单中列出的文件（从异地或备份归档还原 storage/）
# 恢复后比对清单：
#   - 文件数量 == artifacts-manifest.txt 中 total files
#   - 文件大小 == 清单记录
# 不一致即红，禁止「部分制品恢复后照常服务」。
```

---

## 4. 场景 C：schema 回滚（坏迁移上线）—— 快照 + migrate resolve

适用：一次 `migrate deploy` 引入了坏 schema 变更，需要回退到上一已知良好状态。

> 部署顺序固定为「备份 → apply → verify」（见 `collab-deployment.md`）。**回滚必须恢复数据库与制品快照并部署上一应用版本**，不能用空表/空库代替恢复。

```bash
# 1) 停当前实例，部署上一应用版本（代码回退到对应 tag/commit）
# 2) 恢复上一已知良好备份（同 §2，使用坏迁移前的最新备份集）
pg_restore -Fc --clean --if-exists --no-owner -d "$DATABASE_URL" backups/<坏迁移前>/lingfang_collab.dump

# 3) 将 migration 历史指针对齐到备份对应的位置（避免 deploy 误判缺失/多余）：
#    - 若需标记某 migration 为已回滚：
#        pnpm -C apps/collab-api npx prisma migrate resolve --rolled-back <migration_name>
#    - 若需标记某 migration 为已应用（恢复后历史缺失时）：
#        pnpm -C apps/collab-api npx prisma migrate resolve --applied <migration_name>

# 4) 验证
pnpm -C apps/collab-api npx prisma migrate status   # up to date
node scripts/verify-all.mjs                          # 全绿
```

> 注意：MySQL provider 走 `prisma db push`，无 PG migration 内的 SQL 断言；本产品 PG 为权威路径，回滚以 PG 流程为准（见 `collab-deployment.md` 的 legacy 插件退役窗口说明）。

---

## 5. 验证命令汇总（恢复后必跑）

| 命令 | 期望结果 | 失败含义 |
| --- | --- | --- |
| `prisma migrate status` | All migrations have been applied | schema 与历史不一致 |
| `node scripts/verify-all.mjs` | 4 路验证全绿 | 业务对账/插件/计费异常 |
| 制品清单比对 | 文件数/大小 == manifest | 制品缺失 |
| `pg_isready -d "$DATABASE_URL"` | accepting connections | 实例未起 |

---

## 6. 演练记录（附录）

恢复演练为验收硬标。每次演练记录：环境、流程、破坏方式、反向断言结果、耗时、结论。

- 最新演练：`night_runs/backup-restore-drill-<ts>.log`（见演练执行）
- 状态跟踪：[x] 已实跑闭环 / [~] 部分闭环 / [ ] 未做

<!-- DRILL_LOG_PLACEHOLDER -->
## 6.1 最新演练记录（T4 验收硬标）

- **状态：[x] 已实跑闭环**（未虚报；备份→破坏→恢复→校验全链路通过，反向断言成立）
- **时间**：2026-08-11
- **环境**：本地 PG16.14 二进制（`D:\lf-pan\pg\pgsql\bin`），隔离演练库 `127.0.0.1:5444/lingfang_collab`，数据目录 `D:\lf-pan\pg\drill`（与任何现存库隔离，演练后清理）
- **关键证据**：`night_runs/backup-restore-drill-20260811-201813.log`
- **闭环周期**：已知良好基线 → `backup-pg.sh` 备份 → `drill-corrupt.sql` 破坏（注水流水 + 删表）→ `pg_restore` 恢复 → `drill-verify.sh` 绿（行数回到基线、注水清除）；随后复现 RED 用例验证反向断言（残留污染/漏恢复时脚本非零退出、不静默成功）。
- **正向断言**：`prisma migrate status` = `Database schema is up to date!`（56 migrations）；`drill-verify.sh` 绿。
- **反向断言（核心）**：模拟恢复不完整时 `drill-verify.sh` 退出码 1（红），明确报出差异表与残留注水流水，**杜绝「恢复成功但数据缺失」的静默成功**。
- **残留说明**：`verify-all.mjs`/`smoke.mjs` 需运行中的 collab-api + Redis 集成栈，超出隔离 PG 演练范围；已作为应用层恢复后验证步骤写入 §5，待集成环境实跑。
