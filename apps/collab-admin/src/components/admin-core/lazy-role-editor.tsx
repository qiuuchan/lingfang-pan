import { AsyncResource } from '@/components/ui/async-resource';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RoleEditDialog } from '@/components/role-edit-dialog';
import { adminCoreApi } from '@/components/admin-core/api';
import { useAsyncResource } from '@/lib/async-resource';
import type { Role } from '@/lib/types';

export function LazyRoleEditor({
  scope,
  teamId,
  roleId,
  title,
  onClose,
  onSubmit,
}: {
  scope: 'platform' | 'team';
  teamId?: string;
  roleId?: string;
  title: string;
  onClose: () => void;
  onSubmit: (body: {
    name?: string;
    code?: string;
    description?: string;
    permissions?: string[];
  }) => Promise<unknown>;
}) {
  const role = useAsyncResource<Role>(
    (signal) =>
      scope === 'team'
        ? adminCoreApi.teamRoleDetail(teamId!, roleId!, signal)
        : adminCoreApi.roleDetail(roleId!, signal),
    [scope, teamId, roleId],
    { enabled: !!roleId && (scope === 'platform' || !!teamId) }
  );

  const references = useAsyncResource(
    async (signal) => {
      if (scope === 'team') {
        const result = await adminCoreApi.teamRolePermissions(teamId!, signal);
        return { permissions: result.permissions, groups: [] };
      }
      const [permissions, groups] = await Promise.all([
        adminCoreApi.rolePermissions(signal),
        adminCoreApi.permissionGroups(signal),
      ]);
      return { permissions: permissions.permissions, groups: groups.groups };
    },
    [scope, teamId],
    { enabled: scope === 'platform' || !!teamId }
  );

  const loadedRole = roleId ? role.data : undefined;
  const referenceData = references.data;
  const ready = !!referenceData && (!roleId || !!loadedRole);

  if (ready && referenceData) {
    const groupLabels = new Map(
      referenceData.groups
        .filter((group) => group.customized)
        .map((group) => [group.groupKey, group.displayName])
    );
    return (
      <RoleEditDialog
        role={loadedRole}
        permissions={referenceData.permissions}
        groupLabelOverride={groupLabels}
        title={title}
        description={scope === 'team' ? '配置该团队角色的权限。' : '配置平台角色的权限。'}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );
  }

  const status =
    references.status === 'error' || role.status === 'error'
      ? 'error'
      : references.status === 'loading' || (roleId && role.status === 'loading')
        ? 'loading'
        : 'idle';
  const error = references.error ?? role.error;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>正在准备角色编辑器。</DialogDescription>
        </DialogHeader>
        <AsyncResource
          status={status}
          error={error}
          retry={() => {
            references.reload();
            if (roleId) role.reload();
          }}
        >
          <div />
        </AsyncResource>
      </DialogContent>
    </Dialog>
  );
}
