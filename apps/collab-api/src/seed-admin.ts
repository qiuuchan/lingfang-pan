import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const enabled = String(process.env.PLATFORM_ADMIN_BOOTSTRAP_ENABLED ?? 'true') === 'true';
  if (!enabled) {
    console.log('平台管理员 bootstrap 已关闭');
    return;
  }
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
  const displayName = process.env.PLATFORM_ADMIN_NAME || '平台管理员';
  if (!email || !password) throw new Error('缺少 PLATFORM_ADMIN_EMAIL 或 PLATFORM_ADMIN_PASSWORD');

  const existingAdmin = await prisma.user.findFirst({ where: { platformRole: 'PLATFORM_ADMIN' } });
  if (existingAdmin) {
    console.log(`已存在平台管理员：${existingAdmin.email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName, passwordHash, platformRole: 'PLATFORM_ADMIN' },
    update: { platformRole: 'PLATFORM_ADMIN', displayName },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId: user.id,
      action: 'platform_admin.bootstrap',
      targetType: 'User',
      targetId: user.id,
      metadata: { email },
    },
  });
  console.log(`平台管理员已就绪：${email}`);
}

main().finally(async () => prisma.$disconnect());