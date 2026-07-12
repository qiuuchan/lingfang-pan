import { Prisma } from '@prisma/client';
import { auditActionCategory, AUDIT_ACTION_LABEL, type AuditCategoryKey } from './audit-actions';

export type AdminPageQuery = {
  page?: number;
  pageSize?: number;
};

export function normalizeAdminPage(query: AdminPageQuery) {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 20)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export const ADMIN_USER_SUMMARY_SELECT = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  platformRole: true,
  platformRoleId: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.UserSelect;

export const ADMIN_USER_OPTION_SELECT = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  platformRole: true,
} as const satisfies Prisma.UserSelect;

export type AdminUserSummaryRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SUMMARY_SELECT }>;
export type AdminUserOptionRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_OPTION_SELECT }>;

export function adminUserSummary(user: AdminUserSummaryRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    platformRole: user.platformRole,
    platformRoleId: user.platformRoleId,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function adminUserOption(user: AdminUserOptionRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    platformRole: user.platformRole,
  };
}

export const ADMIN_USER_LOGIN_SELECT = {
  id: true,
  action: true,
  createdAt: true,
} as const satisfies Prisma.AuditLogSelect;

export const ADMIN_USER_TEAM_SELECT = {
  teamId: true,
  userId: true,
  role: true,
  status: true,
  teamRoleId: true,
  joinedAt: true,
  team: {
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      balanceCents: true,
    },
  },
} as const satisfies Prisma.TeamMembershipSelect;

export const ADMIN_WALLET_TRANSACTION_SELECT = {
  id: true,
  amountCents: true,
  direction: true,
  reason: true,
  pluginId: true,
  counterpartyUserId: true,
  createdAt: true,
} as const satisfies Prisma.WalletTransactionSelect;

export const ADMIN_TEAM_SUMMARY_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  balanceCents: true,
  defaultPoolId: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      memberships: { where: { status: 'ACTIVE' } },
    },
  },
} as const satisfies Prisma.TeamSelect;

export const ADMIN_TEAM_DETAIL_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  allowPublicJoin: true,
  description: true,
  balanceCents: true,
  defaultPoolId: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TeamSelect;

export const ADMIN_TEAM_MEMBER_SELECT = {
  teamId: true,
  userId: true,
  role: true,
  status: true,
  teamRoleId: true,
  joinedAt: true,
  user: { select: ADMIN_USER_OPTION_SELECT },
  teamRole: { select: { id: true, name: true, code: true } },
} as const satisfies Prisma.TeamMembershipSelect;

export const ADMIN_TEAM_PLUGIN_SELECT = {
  id: true,
  name: true,
  status: true,
  visibility: true,
  reviewStatus: true,
  marketplace: true,
  priceCents: true,
  installCount: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PluginSelect;

export const ADMIN_TEAM_PURCHASE_SELECT = {
  id: true,
  pluginId: true,
  packageId: true,
  buyerUserId: true,
  sellerUserId: true,
  priceCents: true,
  createdAt: true,
  plugin: { select: { id: true, name: true } },
  package: { select: { id: true, name: true } },
} as const satisfies Prisma.PurchaseSelect;

export const ADMIN_TEAM_LEDGER_SELECT = {
  id: true,
  teamId: true,
  amountCents: true,
  direction: true,
  reason: true,
  actorUserId: true,
  createdAt: true,
  actor: { select: { id: true, email: true, displayName: true } },
} as const satisfies Prisma.BalanceLedgerSelect;

export const ADMIN_AUDIT_SUMMARY_SELECT = {
  id: true,
  action: true,
  targetType: true,
  targetId: true,
  createdAt: true,
  actor: { select: { id: true, email: true, displayName: true } },
} as const satisfies Prisma.AuditLogSelect;

export const ADMIN_AUDIT_DETAIL_SELECT = {
  ...ADMIN_AUDIT_SUMMARY_SELECT,
  metadata: true,
} as const satisfies Prisma.AuditLogSelect;

export type AdminAuditSummaryRow = Prisma.AuditLogGetPayload<{ select: typeof ADMIN_AUDIT_SUMMARY_SELECT }>;
export type AdminAuditDetailRow = Prisma.AuditLogGetPayload<{ select: typeof ADMIN_AUDIT_DETAIL_SELECT }>;

export function adminAuditSummary(log: AdminAuditSummaryRow) {
  return {
    id: log.id,
    action: log.action,
    targetType: log.targetType,
    targetId: log.targetId,
    createdAt: log.createdAt,
    actor: log.actor ? {
      id: log.actor.id,
      email: log.actor.email,
      displayName: log.actor.displayName,
    } : null,
  };
}

export function adminAuditDetail(log: AdminAuditDetailRow) {
  return { ...adminAuditSummary(log), metadata: log.metadata };
}

export const ADMIN_ACTIVITY_SELECT = {
  id: true,
  action: true,
  targetType: true,
  targetId: true,
  createdAt: true,
} as const satisfies Prisma.AuditLogSelect;

export type AdminUserListQuery = AdminPageQuery & {
  q?: string;
  status?: 'ACTIVE' | 'DISABLED';
  platformRole?: 'NONE' | 'PLATFORM_ADMIN';
  sort?: 'createdAt' | 'updatedAt' | 'email' | 'displayName';
  order?: 'asc' | 'desc';
};

export function adminUserWhere(query: AdminUserListQuery): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {};
  const keyword = query.q?.trim();
  if (keyword) {
    where.OR = [
      { email: { contains: keyword, mode: 'insensitive' } },
      { displayName: { contains: keyword, mode: 'insensitive' } },
    ];
  }
  if (query.status) where.status = query.status;
  if (query.platformRole) where.platformRole = query.platformRole;
  return where;
}

export function adminUserOrderBy(query: AdminUserListQuery): Prisma.UserOrderByWithRelationInput[] {
  const sort = query.sort ?? 'createdAt';
  const order = query.order ?? 'desc';
  return [
    { [sort]: order } as Prisma.UserOrderByWithRelationInput,
    { id: 'desc' },
  ];
}

export type AdminTeamListQuery = AdminPageQuery & {
  q?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  sort?: 'createdAt' | 'updatedAt' | 'name' | 'balanceCents';
  order?: 'asc' | 'desc';
};

export function adminTeamWhere(query: AdminTeamListQuery): Prisma.TeamWhereInput {
  const where: Prisma.TeamWhereInput = {};
  const keyword = query.q?.trim();
  if (keyword) {
    where.OR = [
      { name: { contains: keyword, mode: 'insensitive' } },
      { slug: { contains: keyword, mode: 'insensitive' } },
    ];
  }
  if (query.status) where.status = query.status;
  return where;
}

export function adminTeamOrderBy(query: AdminTeamListQuery): Prisma.TeamOrderByWithRelationInput[] {
  const sort = query.sort ?? 'createdAt';
  const order = query.order ?? 'desc';
  return [
    { [sort]: order } as Prisma.TeamOrderByWithRelationInput,
    { id: 'desc' },
  ];
}

export type AdminAuditListQuery = AdminPageQuery & {
  category?: AuditCategoryKey;
  q?: string;
  actorId?: string;
  targetType?: string;
};

function auditCategoryPrefixConditions(category: AuditCategoryKey): Prisma.AuditLogWhereInput[] {
  switch (category) {
    case 'auth':
      return [{ action: { startsWith: 'auth.' } }];
    case 'team':
      return [
        { action: { startsWith: 'team.' } },
        { action: { startsWith: 'invitation.' } },
        { action: { startsWith: 'team_admin_application.' } },
        { action: { startsWith: 'role.' } },
        { action: { startsWith: 'plugin.grant.' } },
        { action: { startsWith: 'permission_group.' } },
      ];
    case 'plugin':
      return [{
        AND: [
          { action: { startsWith: 'plugin.' } },
          { NOT: { action: { startsWith: 'plugin.marketplace.' } } },
          { NOT: { action: { startsWith: 'plugin.grant.' } } },
        ],
      }];
    case 'marketplace':
      return [
        { action: { startsWith: 'marketplace.' } },
        { action: { startsWith: 'plugin.marketplace.' } },
      ];
    case 'wallet':
      return [{ action: { startsWith: 'wallet.' } }];
    case 'llm':
      return [{ action: { startsWith: 'llm_binding.' } }];
    case 'admin':
      return [{
        AND: [
          { action: { startsWith: 'admin.' } },
          { NOT: { action: { startsWith: 'admin.setting' } } },
        ],
      }];
    case 'system':
      return [
        { action: { startsWith: 'admin.setting' } },
        { action: { startsWith: 'platform_admin' } },
        { action: { startsWith: 'system.' } },
      ];
  }
}

export function adminAuditWhere(query: AdminAuditListQuery): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (query.actorId) where.actorUserId = query.actorId;
  if (query.targetType) where.targetType = query.targetType;

  let categoryConditions: Prisma.AuditLogWhereInput[] | null = null;
  if (query.category) {
    const conditions = auditCategoryPrefixConditions(query.category);
    const registered = Object.keys(AUDIT_ACTION_LABEL)
      .filter((action) => auditActionCategory(action) === query.category);
    if (registered.length > 0) conditions.push({ action: { in: registered } });
    if (conditions.length > 0) categoryConditions = conditions;
  }

  let keywordConditions: Prisma.AuditLogWhereInput[] | null = null;
  const keyword = query.q?.trim();
  if (keyword) {
    keywordConditions = [
      { action: { contains: keyword, mode: 'insensitive' } },
      { targetId: { contains: keyword, mode: 'insensitive' } },
      { actor: { email: { contains: keyword, mode: 'insensitive' } } },
    ];
  }

  if (categoryConditions && keywordConditions) {
    where.AND = [{ OR: categoryConditions }, { OR: keywordConditions }];
  } else if (categoryConditions) {
    where.OR = categoryConditions;
  } else if (keywordConditions) {
    where.OR = keywordConditions;
  }
  return where;
}
