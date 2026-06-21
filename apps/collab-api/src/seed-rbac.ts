// RBAC seed：权限码注册表 + 内置系统角色权限填充。
//
// 幂等设计（可重复执行）：
//  1. 把 permission-codes.ts 全部权限码 upsert 到 PermissionEntry 表（新增/更新 label/description）。
//  2. 为「系统平台管理员」角色填充全部 platform.* 权限。
//  3. 为每个团队的「系统团队管理员」填充全部 team.* 权限、「系统成员」填充只读基线权限。
//  4. 若团队级系统角色缺失（如迁移后新建团队但未触发应用层 hook），按需补建。
//
// 内置角色 id 约定（与 migration 20260621190000 一致）：
//  - 平台级：'00000000-0000-0000-0000-platform0001'
//  - 团队级：'team-admin-<teamId>' / 'team-member-<teamId>'
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from './prisma.adapter';
import {
  ALL_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  TEAM_PERMISSIONS,
  type PermissionScope,
} from './modules/permissions/permission-codes';

const adapter = createPrismaAdapter(process.env);
const prisma = new PrismaClient({ adapter });

/** 系统成员只读基线权限。 */
const MEMBER_BASELINE_PERMISSIONS = [
  'team.dashboard.view',
  'team.plugin.list',
  'team.balance.view',
];

/** 系统平台管理员角色 id（与 migration 固定占位一致）。 */
const PLATFORM_ADMIN_ROLE_ID = '00000000-0000-0000-0000-platform0001';
/** 团队级系统角色 id 拼接前缀。 */
const teamAdminRoleId = (teamId: string) => `team-admin-${teamId}`;
const teamMemberRoleId = (teamId: string) => `team-member-${teamId}`;

async function seedPermissionEntries() {
  for (const p of ALL_PERMISSIONS) {
    await prisma.permissionEntry.upsert({
      where: { code: p.code },
      update: { label: p.label, scope: p.scope as PermissionScope, group: p.group, description: p.description },
      create: { code: p.code, label: p.label, scope: p.scope as PermissionScope, group: p.group, description: p.description },
    });
  }
  console.log(`permission seed 完成：${ALL_PERMISSIONS.length} 条权限码已同步到 PermissionEntry。`);
}

async function seedPlatformAdminRole() {
  const platformCodes = PLATFORM_PERMISSIONS.map((p) => p.code);
  // 内置平台管理员角色（migration 已建，此处幂等 upsert）
  await prisma.role.upsert({
    where: { id: PLATFORM_ADMIN_ROLE_ID },
    update: { permissions: platformCodes },
    create: {
      id: PLATFORM_ADMIN_ROLE_ID,
      name: '系统平台管理员',
      scope: 'PLATFORM',
      teamId: null,
      isSystem: true,
      description: '内置平台管理员角色，拥有全部平台权限',
      permissions: platformCodes,
    },
  });
  console.log(`角色 seed：系统平台管理员（${platformCodes.length} 条权限）。`);
}

async function seedTeamSystemRoles() {
  const teams = await prisma.team.findMany({ select: { id: true } });
  const teamCodes = TEAM_PERMISSIONS.map((p) => p.code);

  for (const team of teams) {
    // 系统团队管理员：幂等 upsert（缺则建，有则刷新 permissions）
    await prisma.role.upsert({
      where: { id: teamAdminRoleId(team.id) },
      update: { permissions: teamCodes },
      create: {
        id: teamAdminRoleId(team.id),
        name: '系统团队管理员',
        scope: 'TEAM',
        teamId: team.id,
        isSystem: true,
        description: '内置团队管理员角色，拥有全部团队权限',
        permissions: teamCodes,
      },
    });

    // 系统成员：幂等 upsert
    await prisma.role.upsert({
      where: { id: teamMemberRoleId(team.id) },
      update: { permissions: MEMBER_BASELINE_PERMISSIONS },
      create: {
        id: teamMemberRoleId(team.id),
        name: '系统成员',
        scope: 'TEAM',
        teamId: team.id,
        isSystem: true,
        description: '内置成员角色，拥有只读基线权限',
        permissions: MEMBER_BASELINE_PERMISSIONS,
      },
    });
  }
  console.log(`角色 seed：${teams.length} 个团队的系统团队管理员/系统成员角色已同步。`);
}

async function main() {
  await seedPermissionEntries();
  await seedPlatformAdminRole();
  await seedTeamSystemRoles();
  console.log('RBAC seed 完成。');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
