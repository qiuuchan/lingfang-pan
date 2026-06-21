// RBAC seed：权限码注册表 + 内置系统角色权限填充 + 存量用户/成员角色回填。
//
// 幂等设计（可重复执行）：
//  1. 把 permission-codes.ts 全部权限码 upsert 到 PermissionEntry 表（新增/更新 label/description）。
//  2. 为「系统平台管理员」角色填充全部 platform.* 权限。
//  3. 为每个团队的「系统团队管理员」填充全部 team.* 权限、「系统成员」填充只读基线权限。
//  4. 若团队级系统角色缺失（如迁移后新建团队但未触发应用层 hook），按需补建。
//  5. 回填存量数据：platformRole=PLATFORM_ADMIN 但 platformRoleId 缺失的用户、
//     role=TEAM_ADMIN/MEMBER 但 teamRoleId 缺失的成员（兼容旧版 seed-admin/setup/admin 创建的数据）。
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from './prisma.adapter';
import {
  ALL_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  TEAM_PERMISSIONS,
  BUILTIN_PERMISSION_GROUPS,
  SYSTEM_PLATFORM_ADMIN_ROLE_ID,
  SYSTEM_PLATFORM_ADMIN_ROLE_CODE,
  SYSTEM_TEAM_ADMIN_ROLE_CODE,
  SYSTEM_TEAM_MEMBER_ROLE_CODE,
  teamAdminRoleId,
  teamMemberRoleId,
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

async function seedPermissionEntries() {
  for (const p of ALL_PERMISSIONS) {
    await prisma.permissionEntry.upsert({
      where: { code: p.code },
      update: {
        label: p.label,
        scope: p.scope as PermissionScope,
        group: p.group,
        moduleKey: p.moduleKey,
        moduleLabel: p.moduleLabel,
        moduleOrder: p.moduleOrder,
        description: p.description,
      },
      create: {
        code: p.code,
        label: p.label,
        scope: p.scope as PermissionScope,
        group: p.group,
        moduleKey: p.moduleKey,
        moduleLabel: p.moduleLabel,
        moduleOrder: p.moduleOrder,
        description: p.description,
      },
    });
  }
  console.log(`permission seed 完成：${ALL_PERMISSIONS.length} 条权限码已同步到 PermissionEntry。`);
}

/** seed 内置权限分组（PermissionGroup 表，isSystem=true，与 BUILTIN_PERMISSION_GROUPS 对齐）。 */
async function seedPermissionGroups() {
  for (const g of BUILTIN_PERMISSION_GROUPS) {
    await prisma.permissionGroup.upsert({
      where: { scope_groupKey: { scope: g.scope as PermissionScope, groupKey: g.groupKey } },
      update: { sortOrder: g.sortOrder },
      create: {
        scope: g.scope as PermissionScope,
        groupKey: g.groupKey,
        displayName: g.displayName,
        sortOrder: g.sortOrder,
        isSystem: true,
      },
    });
  }
  console.log(`权限分组 seed：${BUILTIN_PERMISSION_GROUPS.length} 条内置分组已同步到 PermissionGroup。`);
}

async function seedPlatformAdminRole() {
  const platformCodes = PLATFORM_PERMISSIONS.map((p) => p.code);
  // 内置平台管理员角色（migration 已建，此处幂等 upsert）
  await prisma.role.upsert({
    where: { id: SYSTEM_PLATFORM_ADMIN_ROLE_ID },
    update: { permissions: platformCodes, code: SYSTEM_PLATFORM_ADMIN_ROLE_CODE },
    create: {
      id: SYSTEM_PLATFORM_ADMIN_ROLE_ID,
      name: '系统平台管理员',
      code: SYSTEM_PLATFORM_ADMIN_ROLE_CODE,
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
    // 系统团队管理员：幂等 upsert（缺则建，有则刷新 permissions + code）
    await prisma.role.upsert({
      where: { id: teamAdminRoleId(team.id) },
      update: { permissions: teamCodes, code: SYSTEM_TEAM_ADMIN_ROLE_CODE },
      create: {
        id: teamAdminRoleId(team.id),
        name: '系统团队管理员',
        code: SYSTEM_TEAM_ADMIN_ROLE_CODE,
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
      update: { permissions: MEMBER_BASELINE_PERMISSIONS, code: SYSTEM_TEAM_MEMBER_ROLE_CODE },
      create: {
        id: teamMemberRoleId(team.id),
        name: '系统成员',
        code: SYSTEM_TEAM_MEMBER_ROLE_CODE,
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

/**
 * 回填存量数据：兼容旧版（migration 前）通过 seed-admin/setup/admin 创建的用户/成员，
 * 他们只有 platformRole/role 枚举，缺 platformRoleId/teamRoleId，会导致新权限守卫解析不到权限。
 * 幂等：只更新 roleId 为 null 的行。
 */
async function backfillExistingRoleRefs() {
  // 平台管理员：platformRole=PLATFORM_ADMIN 但 platformRoleId 缺失 → 指向系统平台管理员角色
  const adminBackfilled = await prisma.user.updateMany({
    where: { platformRole: 'PLATFORM_ADMIN', platformRoleId: null },
    data: { platformRoleId: SYSTEM_PLATFORM_ADMIN_ROLE_ID },
  });
  if (adminBackfilled.count > 0) {
    console.log(`回填：${adminBackfilled.count} 个平台管理员用户的 platformRoleId 已补齐。`);
  }

  // 团队成员：role=TEAM_ADMIN/MEMBER 但 teamRoleId 缺失 → 指向对应系统团队角色。
  // updateMany 无法用 teamId 拼 roleId，按团队循环更新（与 migration 回填同款语义）。
  const teams = await prisma.team.findMany({ select: { id: true } });
  let totalMembershipBackfilled = 0;
  for (const team of teams) {
    const r1 = await prisma.teamMembership.updateMany({
      where: { teamId: team.id, role: 'TEAM_ADMIN', teamRoleId: null },
      data: { teamRoleId: teamAdminRoleId(team.id) },
    });
    const r2 = await prisma.teamMembership.updateMany({
      where: { teamId: team.id, role: 'MEMBER', teamRoleId: null },
      data: { teamRoleId: teamMemberRoleId(team.id) },
    });
    totalMembershipBackfilled += r1.count + r2.count;
  }
  if (totalMembershipBackfilled > 0) {
    console.log(`回填：${totalMembershipBackfilled} 个团队成员的 teamRoleId 已补齐。`);
  }
}

async function main() {
  await seedPermissionEntries();
  await seedPermissionGroups();
  await seedPlatformAdminRole();
  await seedTeamSystemRoles();
  await backfillExistingRoleRefs();
  console.log('RBAC seed 完成。');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
