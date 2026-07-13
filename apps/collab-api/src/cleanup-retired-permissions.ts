import 'dotenv/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import { createPrismaAdapter } from './prisma.adapter';
import { RETIRED_PERMISSION_CODES, stripRetiredPermissions } from './modules/permissions/permission-codes';

type PermissionCleanupClient = Pick<Prisma.TransactionClient, 'role' | 'permissionEntry' | 'permissionGroup'>;

/** Idempotent for PostgreSQL scalar arrays and MySQL JSON arrays. */
export async function cleanupRetiredPermissions(prisma: PermissionCleanupClient): Promise<number> {
  const roles = await prisma.role.findMany({ select: { id: true, permissions: true } });
  let changedRoles = 0;
  for (const role of roles) {
    const current = Array.isArray(role.permissions) ? role.permissions.filter((code): code is string => typeof code === 'string') : [];
    const stripped = stripRetiredPermissions(current);
    if (!stripped.changed) continue;
    await prisma.role.update({ where: { id: role.id }, data: { permissions: stripped.permissions } });
    changedRoles += 1;
  }

  await prisma.permissionEntry.deleteMany({
    where: { code: { in: [...RETIRED_PERMISSION_CODES] } },
  });
  await prisma.permissionGroup.deleteMany({
    where: { scope: 'TEAM', groupKey: 'team.api_key' },
  });
  return changedRoles;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ adapter: createPrismaAdapter(process.env) });
  try {
    const changedRoles = await prisma.$transaction((tx) => cleanupRetiredPermissions(tx));
    console.log(`过期 relay 权限清理完成：${changedRoles} 个角色已更新。`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
