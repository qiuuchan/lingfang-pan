import type {
  AuditLog,
  LedgerDirection,
  PermissionEntry,
  PermissionGroup,
  PlatformRole,
  PluginReviewStatus,
  PluginStatus,
  PluginVisibility,
  Role,
  Team,
  TeamLedgerEntry,
  TeamMember,
  TeamPurchaseEntry,
  User,
  UserStatus,
} from '@/lib/types';

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type UserSummary = User & {
  createdAt?: string;
  updatedAt?: string;
  emailVerified?: boolean | string | null;
  platformRoleId?: string | null;
  teamCount?: number;
};

export type UserListQuery = {
  page: number;
  pageSize: number;
  q?: string;
  status?: UserStatus;
  platformRole?: PlatformRole;
};

export type UserLoginEntry = Pick<AuditLog, 'id' | 'action' | 'createdAt'>;

export type UserTeamEntry = {
  teamId: string;
  role: string;
  status: string;
  joinedAt: string;
  team: Pick<Team, 'id' | 'name' | 'slug' | 'status' | 'balanceCents'>;
};

export type UserWalletEntry = {
  id: string;
  amountCents: number;
  direction: LedgerDirection;
  reason: string;
  pluginId?: string | null;
  createdAt: string;
};

export type UserWalletPage = Page<UserWalletEntry> & {
  balanceCents: number;
};

export type UserOption = Pick<User, 'id' | 'email' | 'displayName' | 'status' | 'platformRole'>;

export type TeamSummary = Team & {
  memberCount: number;
  adminCount?: number;
  adminNames?: string[];
  pluginCount?: number;
};

export type TeamListQuery = {
  page: number;
  pageSize: number;
  q?: string;
  status?: Team['status'];
};

export type TeamOverview = {
  team: Team & { updatedAt?: string };
  memberCount: number;
  roleCount: number;
  pluginCount: number;
  purchaseCount: number;
  ledgerSummary: {
    totalCreditCents: number;
    totalDebitCents: number;
    netCents: number;
  };
};

export type TeamPluginEntry = {
  id: string;
  name: string;
  status: PluginStatus;
  visibility: PluginVisibility;
  reviewStatus: PluginReviewStatus;
  marketplace: boolean;
  priceCents: number;
  installCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RoleSummary = Omit<Role, 'permissions'> & {
  permissionCount: number;
};

export type TeamMemberEntry = TeamMember & {
  teamRole?: { id: string; name: string; code: string | null } | null;
};

export type RoleListQuery = {
  page: number;
  pageSize: number;
  q?: string;
};

export type RoleEditorReferenceData = {
  permissions: PermissionEntry[];
  groups: PermissionGroup[];
};

export type TeamMembersPage = Page<TeamMemberEntry>;
export type TeamRolesPage = Page<RoleSummary>;
export type TeamPluginsPage = Page<TeamPluginEntry>;
export type TeamPurchasesPage = Page<TeamPurchaseEntry>;
export type TeamLedgerPage = Page<TeamLedgerEntry & {
  actor?: { id: string; email: string; displayName: string } | null;
}> & {
  summary: {
    totalCreditCents: number;
    totalDebitCents: number;
    netCents: number;
  };
};
