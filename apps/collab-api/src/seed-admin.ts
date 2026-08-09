import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from './prisma.adapter';
import {
  SYSTEM_PLATFORM_ADMIN_ROLE_ID,
  SYSTEM_PLATFORM_ADMIN_ROLE_CODE,
} from './modules/permissions/permission-codes';

const adapter = createPrismaAdapter(process.env);
const prisma = new PrismaClient({ adapter });

async function main() {
  // H-6 修复：默认关闭 bootstrap（此前默认开启 + ChangeMe123! 弱口令示例）。
  // 显式开启后才执行；生产部署建议完成后立即关闭该开关并轮换口令。
  const enabled = String(process.env.PLATFORM_ADMIN_BOOTSTRAP_ENABLED ?? 'false') === 'true';
  if (!enabled) {
    console.log('平台管理员 bootstrap 已关闭（PLATFORM_ADMIN_BOOTSTRAP_ENABLED=false）');
    return;
  }
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
  const displayName = process.env.PLATFORM_ADMIN_NAME || '平台管理员';
  if (!email || !password) throw new Error('缺少 PLATFORM_ADMIN_EMAIL 或 PLATFORM_ADMIN_PASSWORD');

  // H-6：拒绝弱口令（含公开示例值 ChangeMe123!）。密码必须 ≥12 字符且含字母+数字（弱口令拒绝，
  // 不静默接受——否则示例口令再次上生产等于没修）。
  const weakPatterns = ['changeme', 'password', '123456', 'qwerty', 'admin'];
  const lower = password.toLowerCase();
  if (password.length < 12 || weakPatterns.some((w) => lower.includes(w)) || !/\d/.test(password)) {
    throw new Error(
      'PLATFORM_ADMIN_PASSWORD 过弱：至少 12 字符、含字母与数字，且不得包含 changeme/password/123456 等常见弱串'
    );
  }

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
  // H-6：update 分支**不**重置 platformRole/platformRoleId——该邮箱已存在且被 admin 降级时，
  // seed 只补 displayName/passwordHash，绝不把降级管理员「复活」回平台管理员（防 seed 覆盖管理决策）。
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      displayName,
      passwordHash,
      platformRole: 'PLATFORM_ADMIN',
      platformRoleId: SYSTEM_PLATFORM_ADMIN_ROLE_ID,
    },
    update: {
      displayName,
      passwordHash,
    },
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
