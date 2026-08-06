// 将市场结算 writerMode 切到 SETTLEMENT_V2（幂等 upsert 单例行）。
// 这是「购买真实扣灵石」的前提；项目默认 LEGACY（购买不扣费）。
// 用法：node scripts/enable-settlement-v2.mjs  （需 DATABASE_URL 环境变量）
//
// 解析说明：本脚本位于 scripts/，而 @prisma/client 与 @prisma/adapter-pg 安装在
// apps/collab-api/node_modules。ESM 的 bare import 按文件位置解析（不走 cwd、也不认
// NODE_PATH），故用 createRequire 把解析基点锚到 apps/collab-api/package.json。
// Prisma 7 必须配 driver adapter（与 collab-api 的 createPrismaAdapter 一致）：postgresql
// 走 PrismaPg({ connectionString })。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../apps/collab-api/package.json'));
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// 允许 DATABASE_URL 来自环境变量或 collab-api/.env（与运行中的 API 一致）。
try {
  require('dotenv').config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../apps/collab-api/.env') });
} catch { /* dotenv 缺失时忽略，依赖已设置的环境变量 */ }

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn('[enable-settlement-v2] 未设置 DATABASE_URL，跳过（假定库已为 SETTLEMENT_V2）');
  process.exit(0);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const row = await prisma.marketplaceCommerceState.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', writerMode: 'SETTLEMENT_V2', settlementV2ActivatedAt: new Date() },
    update: { writerMode: 'SETTLEMENT_V2', settlementV2ActivatedAt: new Date() },
  });
  console.log(`[enable-settlement-v2] writerMode -> ${row.writerMode} (激活于 ${row.settlementV2ActivatedAt})`);
} finally {
  await prisma.$disconnect();
}
