import { Prisma, type ApplicationStatus } from '@prisma/client';
import {
  SYSTEM_TEAM_ADMIN_ROLE_CODE,
  SYSTEM_TEAM_MEMBER_ROLE_CODE,
  TEAM_PERMISSIONS,
  teamAdminRoleId,
  teamMemberRoleId,
} from './permissions/permission-codes';

const MEMBER_BASELINE_PERMISSIONS = [
  'team.dashboard.view',
  'team.plugin.list',
  'team.balance.view',
];

const governanceUserSelect = {
  id: true,
  email: true,
  displayName: true,
} as const;

export const adminApplicationSummarySelect = {
  id: true,
  teamName: true,
  status: true,
  createdAt: true,
  user: { select: governanceUserSelect },
} satisfies Prisma.TeamAdminApplicationSelect;

export const adminApplicationDetailSelect = {
  ...adminApplicationSummarySelect,
  reason: true,
  reviewReason: true,
  reviewedAt: true,
  reviewedBy: { select: governanceUserSelect },
} satisfies Prisma.TeamAdminApplicationSelect;

export type AdminApplicationListQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: ApplicationStatus;
};

type AdminApplicationSummaryRecord = Prisma.TeamAdminApplicationGetPayload<{
  select: typeof adminApplicationSummarySelect;
}>;

type AdminApplicationDetailRecord = Prisma.TeamAdminApplicationGetPayload<{
  select: typeof adminApplicationDetailSelect;
}>;

export function buildAdminApplicationListQuery(query: AdminApplicationListQuery) {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 20)));
  const q = query.q?.trim();
  const where: Prisma.TeamAdminApplicationWhereInput = {};

  if (query.status) where.status = query.status;
  if (q) {
    where.OR = [
      { teamName: { contains: q, mode: 'insensitive' } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { user: { displayName: { contains: q, mode: 'insensitive' } } },
    ];
  }

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    where,
  };
}

export function applicationTeamSystemRoles(teamId: string) {
  const adminRoleId = teamAdminRoleId(teamId);
  return {
    adminRoleId,
    roles: [
      {
        id: adminRoleId,
        name: '系统团队管理员',
        code: SYSTEM_TEAM_ADMIN_ROLE_CODE,
        scope: 'TEAM' as const,
        teamId,
        isSystem: true,
        description: '内置团队管理员角色，拥有全部团队权限',
        permissions: TEAM_PERMISSIONS.map((permission) => permission.code),
      },
      {
        id: teamMemberRoleId(teamId),
        name: '系统成员',
        code: SYSTEM_TEAM_MEMBER_ROLE_CODE,
        scope: 'TEAM' as const,
        teamId,
        isSystem: true,
        description: '内置成员角色，拥有只读基线权限',
        permissions: MEMBER_BASELINE_PERMISSIONS,
      },
    ],
  };
}

function governanceUser(user: AdminApplicationSummaryRecord['user']) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}

export function adminApplicationSummary(application: AdminApplicationSummaryRecord) {
  return {
    id: application.id,
    teamName: application.teamName,
    status: application.status,
    createdAt: application.createdAt.toISOString(),
    user: governanceUser(application.user),
  };
}

export function adminApplicationDetail(application: AdminApplicationDetailRecord) {
  return {
    ...adminApplicationSummary(application),
    reason: application.reason,
    reviewReason: application.reviewReason,
    reviewedAt: application.reviewedAt?.toISOString() ?? null,
    reviewedBy: application.reviewedBy ? governanceUser(application.reviewedBy) : null,
  };
}
