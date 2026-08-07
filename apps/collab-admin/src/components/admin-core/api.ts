import { api } from '@/lib/api';
import type { AuditLog, PermissionEntry, PermissionGroup, Role } from '@/lib/types';
import type {
  Page,
  RoleListQuery,
  RoleSummary,
  TeamLedgerPage,
  TeamListQuery,
  TeamMembersPage,
  TeamOverview,
  TeamPluginsPage,
  TeamPurchasesPage,
  TeamRolesPage,
  TeamSummary,
  UserListQuery,
  UserLoginEntry,
  UserOption,
  UserSummary,
  UserTeamEntry,
  UserWalletPage,
} from '@/components/admin-core/types';

type QueryValue = string | number | boolean | null | undefined;

export function endpoint(path: string, query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export function unwrapEntity<T>(payload: T | { user: T } | { role: T }): T {
  if (payload && typeof payload === 'object' && 'user' in payload) return payload.user;
  if (payload && typeof payload === 'object' && 'role' in payload) return payload.role;
  return payload as T;
}

export const adminCoreApi = {
  users(query: UserListQuery, signal: AbortSignal) {
    return api<Page<UserSummary>>(endpoint('/api/admin/users', query), { signal });
  },
  async userDetail(id: string, signal: AbortSignal) {
    const payload = await api<UserSummary | { user: UserSummary }>(
      `/api/admin/users/${id}/detail`,
      { signal }
    );
    return unwrapEntity(payload);
  },
  userLogins(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<Page<UserLoginEntry>>(
      endpoint(`/api/admin/users/${id}/logins`, { page, pageSize }),
      { signal }
    );
  },
  userTeams(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<Page<UserTeamEntry>>(endpoint(`/api/admin/users/${id}/teams`, { page, pageSize }), {
      signal,
    });
  },
  userWallet(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<UserWalletPage>(endpoint(`/api/admin/users/${id}/wallet`, { page, pageSize }), {
      signal,
    });
  },
  adminActivity(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<Page<AuditLog>>(endpoint(`/api/admin/admins/${id}/activity`, { page, pageSize }), {
      signal,
    });
  },
  userOptions(q: string, signal: AbortSignal, limit = 20) {
    return api<Page<UserOption>>(endpoint('/api/admin/users/options', { q, limit }), { signal });
  },
  teams(query: TeamListQuery, signal: AbortSignal) {
    return api<Page<TeamSummary>>(endpoint('/api/admin/teams', query), { signal });
  },
  teamDetail(id: string, signal: AbortSignal) {
    return api<TeamOverview>(`/api/admin/teams/${id}/detail`, { signal });
  },
  teamMembers(id: string, page: number, pageSize: number, q: string, signal: AbortSignal) {
    return api<TeamMembersPage>(endpoint(`/api/admin/teams/${id}/members`, { page, pageSize, q }), {
      signal,
    });
  },
  teamRoles(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<TeamRolesPage>(endpoint(`/api/admin/teams/${id}/roles`, { page, pageSize }), {
      signal,
    });
  },
  teamPlugins(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<TeamPluginsPage>(endpoint(`/api/admin/teams/${id}/plugins`, { page, pageSize }), {
      signal,
    });
  },
  teamPurchases(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<TeamPurchasesPage>(
      endpoint(`/api/admin/teams/${id}/purchases`, { page, pageSize }),
      { signal }
    );
  },
  teamLedger(id: string, page: number, pageSize: number, signal: AbortSignal) {
    return api<TeamLedgerPage>(endpoint(`/api/admin/teams/${id}/ledger`, { page, pageSize }), {
      signal,
    });
  },
  async teamRoleDetail(teamId: string, roleId: string, signal: AbortSignal) {
    const payload = await api<Role | { role: Role }>(`/api/admin/teams/${teamId}/roles/${roleId}`, {
      signal,
    });
    return unwrapEntity(payload);
  },
  teamRolePermissions(teamId: string, signal: AbortSignal) {
    return api<{ permissions: PermissionEntry[] }>(`/api/admin/teams/${teamId}/roles/permissions`, {
      signal,
    });
  },
  roles(query: RoleListQuery, signal: AbortSignal) {
    return api<Page<RoleSummary>>(endpoint('/api/admin/roles', query), { signal });
  },
  async roleDetail(id: string, signal: AbortSignal) {
    const payload = await api<Role | { role: Role }>(`/api/admin/roles/${id}`, { signal });
    return unwrapEntity(payload);
  },
  rolePermissions(signal: AbortSignal) {
    return api<{ permissions: PermissionEntry[] }>('/api/admin/roles/permissions', { signal });
  },
  permissionGroups(signal: AbortSignal) {
    return api<{ groups: PermissionGroup[] }>('/api/admin/permission-groups', { signal });
  },
};
