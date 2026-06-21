import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from './prisma.adapter';
import { SYSTEM_PLATFORM_ADMIN_ROLE_ID, SYSTEM_PLATFORM_ADMIN_ROLE_CODE } from './modules/permissions/permission-codes';

const adapter = createPrismaAdapter(process.env);
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

  // RBAC：确保系统平台管理员角色存在（seed-rbac 负责建角色 + 填权限，此处兜底防止 seed-admin 单独运行）。
  await prisma.role.upsert({
    where: { id: SYSTEM_PLATFORM_ADMIN_ROLE_ID },
    update: {},
    create: {
      id: SYSTEM_PLATFORM_ADMIN_ROLE_ID,
      name: '系统平台管理员',
      code: SYSTEM_PLATFORM_ADMIN_ROLE_CODE,
      scope: 'PLATFORM',
      teamId: null,
      isSystem: true,
      description: '内置平台管理员角色，拥有全部平台权限',
      permissions: [],
    },
  });

  const passwordHash = await bcrypt.hash(password, 12);
  // RBAC 双写：platformRole 枚举 + platformRoleId 同步，否则新权限守卫解析不到平台角色权限。
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName, passwordHash, platformRole: 'PLATFORM_ADMIN', platformRoleId: SYSTEM_PLATFORM_ADMIN_ROLE_ID },
    update: { platformRole: 'PLATFORM_ADMIN', displayName, platformRoleId: SYSTEM_PLATFORM_ADMIN_ROLE_ID },
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
