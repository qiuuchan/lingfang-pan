// 权限码迁移单测：覆盖 expandLegacyPermissions（旧码扩张为新码集合）的幂等性 + 正确性 + 系统角色不受影响。
// 纯函数（无 Prisma 依赖），直接构造含旧码的 Role fixture 跑 expand，断言扩张结果 + 二次跑 no-op。
import { describe, expect, it } from 'vitest';
import {
  expandLegacyPermissions,
  LEGACY_PERMISSION_CODES,
  LEGACY_PERMISSION_EXPANSION,
  ALL_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  TEAM_PERMISSIONS,
  stripRetiredPermissions,
} from './permission-codes';

describe('stripRetiredPermissions 外部 relay 权限清理', () => {
  it('从系统/自定义角色确定性移除全部废弃码并保持幂等', () => {
    const first = stripRetiredPermissions([
      'team.dashboard.view',
      'team.api_key.manage',
      'platform.billing.api_key.manage',
      'platform.billing.relay_docs.view',
    ]);
    expect(first).toEqual({ permissions: ['team.dashboard.view'], changed: true });
    expect(stripRetiredPermissions(first.permissions)).toEqual({
      permissions: ['team.dashboard.view'],
      changed: false,
    });
  });
});

describe('expandLegacyPermissions 旧码扩张', () => {
  it('team.plugin.edit → [edit_metadata, edit_draft, edit_price]，其余权限保留', () => {
    const before = ['team.dashboard.view', 'team.plugin.edit', 'team.plugin.list'];
    const { permissions, changed } = expandLegacyPermissions(before);
    expect(changed).toBe(true);
    expect(permissions.sort()).toEqual(
      [
        'team.dashboard.view',
        'team.plugin.edit_metadata',
        'team.plugin.edit_draft',
        'team.plugin.edit_price',
        'team.plugin.list',
      ].sort()
    );
  });

  it('platform.user.update → [update_profile, reset_password]', () => {
    const { permissions, changed } = expandLegacyPermissions([
      'platform.user.update',
      'platform.user.list',
    ]);
    expect(changed).toBe(true);
    expect(permissions.sort()).toEqual(
      ['platform.user.update_profile', 'platform.user.reset_password', 'platform.user.list'].sort()
    );
  });

  it('team.role.manage → [create, update, delete]', () => {
    const { permissions, changed } = expandLegacyPermissions(['team.role.manage']);
    expect(changed).toBe(true);
    expect(permissions.sort()).toEqual(
      ['team.role.create', 'team.role.update', 'team.role.delete'].sort()
    );
  });

  it('platform.plugin.manage → [edit, delete]', () => {
    const { permissions, changed } = expandLegacyPermissions(['platform.plugin.manage']);
    expect(changed).toBe(true);
    expect(permissions.sort()).toEqual(['platform.plugin.edit', 'platform.plugin.delete'].sort());
  });

  it('混合多个旧码 + 非旧码权限一起扩张', () => {
    const before = [
      'team.dashboard.view',
      'team.plugin.edit',
      'platform.user.update',
      'platform.plugin.manage',
    ];
    const { permissions, changed } = expandLegacyPermissions(before);
    expect(changed).toBe(true);
    expect(permissions).toContain('team.plugin.edit_metadata');
    expect(permissions).toContain('platform.user.reset_password');
    expect(permissions).toContain('platform.plugin.delete');
    expect(permissions).toContain('team.dashboard.view');
    // 旧码不应残留
    expect(permissions).not.toContain('team.plugin.edit');
    expect(permissions).not.toContain('platform.user.update');
    expect(permissions).not.toContain('platform.plugin.manage');
  });

  it('幂等：对扩张后的结果再跑一次应为 no-op（changed=false，集合不变）', () => {
    const before = ['team.plugin.edit', 'platform.user.update', 'team.dashboard.view'];
    const first = expandLegacyPermissions(before);
    expect(first.changed).toBe(true);
    // 二次跑：已无旧码，应 changed=false 且 permissions 不变（仅顺序可能不同）
    const second = expandLegacyPermissions(first.permissions);
    expect(second.changed).toBe(false);
    expect(second.permissions.sort()).toEqual(first.permissions.sort());
  });

  it('无旧码的权限集：changed=false，原样返回（去重）', () => {
    const before = ['team.dashboard.view', 'team.dashboard.view', 'team.plugin.list'];
    const { permissions, changed } = expandLegacyPermissions(before);
    expect(changed).toBe(false);
    expect(permissions.sort()).toEqual(['team.dashboard.view', 'team.plugin.list'].sort());
  });

  it('空数组：changed=false，返回空数组', () => {
    const { permissions, changed } = expandLegacyPermissions([]);
    expect(changed).toBe(false);
    expect(permissions).toEqual([]);
  });

  it('系统角色（全量 PLATFORM_PERMISSIONS）扩张后不含旧码且权限数不丢失', () => {
    // 模拟 seed 后的系统平台管理员角色权限（已是新码集，不含旧码）
    const systemPerms = PLATFORM_PERMISSIONS.map((p) => p.code);
    const { permissions, changed } = expandLegacyPermissions(systemPerms);
    expect(changed).toBe(false); // 系统角色不应含旧码
    expect(permissions.sort()).toEqual(systemPerms.sort());
  });

  it('系统团队管理员角色（全量 TEAM_PERMISSIONS）扩张后不含旧码且权限数不丢失', () => {
    const teamPerms = TEAM_PERMISSIONS.map((p) => p.code);
    const { permissions, changed } = expandLegacyPermissions(teamPerms);
    expect(changed).toBe(false);
    expect(permissions.sort()).toEqual(teamPerms.sort());
  });

  it('自定义角色含旧码：扩张后新码全部在注册表白名单内（合法）', () => {
    const valid = new Set(ALL_PERMISSIONS.map((p) => p.code));
    const before = [
      'team.plugin.edit',
      'platform.user.update',
      'team.role.manage',
      'platform.plugin.manage',
      'team.balance.view',
    ];
    const { permissions } = expandLegacyPermissions(before);
    for (const code of permissions) {
      expect(valid.has(code), `扩张后码 ${code} 必须在注册表白名单内`).toBe(true);
    }
  });
});

describe('LEGACY_PERMISSION_EXPANSION 注册表一致性', () => {
  it('4 个旧码 key 全部已废弃（不在 ALL_PERMISSIONS）', () => {
    const valid = new Set(ALL_PERMISSIONS.map((p) => p.code));
    for (const legacyCode of Object.keys(LEGACY_PERMISSION_EXPANSION)) {
      expect(valid.has(legacyCode), `旧码 ${legacyCode} 不应再出现在注册表`).toBe(false);
    }
  });

  it('每个旧码扩张出的新码全部在注册表白名单内', () => {
    const valid = new Set(ALL_PERMISSIONS.map((p) => p.code));
    for (const [legacy, targets] of Object.entries(LEGACY_PERMISSION_EXPANSION)) {
      expect(targets.length).toBeGreaterThan(0);
      for (const t of targets) {
        expect(valid.has(t), `旧码 ${legacy} 扩张的新码 ${t} 必须在注册表`).toBe(true);
      }
    }
  });

  it('LEGACY_PERMISSION_CODES 与 LEGACY_PERMISSION_EXPANSION 的 key 一致', () => {
    expect([...LEGACY_PERMISSION_CODES].sort()).toEqual(
      Object.keys(LEGACY_PERMISSION_EXPANSION).sort()
    );
  });
});
