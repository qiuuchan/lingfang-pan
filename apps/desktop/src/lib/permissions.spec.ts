import { describe, expect, it } from 'vitest';
import { hasPermission, isPlatformManager, isTeamManager } from './permissions';

const TEAM_BASELINE = ['team.dashboard.view', 'team.plugin.list', 'team.balance.view'];

describe('hasPermission', () => {
  it('returns false when no code is requested', () => {
    expect(hasPermission(['team.plugin.create'])).toBe(false);
    expect(hasPermission([])).toBe(false);
  });

  it('returns true when the single requested code is granted', () => {
    expect(hasPermission(['team.plugin.create'], 'team.plugin.create')).toBe(true);
  });

  it('returns false when the single requested code is missing', () => {
    expect(hasPermission(['team.plugin.list'], 'team.plugin.create')).toBe(false);
    expect(hasPermission([], 'team.plugin.create')).toBe(false);
  });

  it('uses OR semantics across multiple codes', () => {
    const permissions = ['team.plugin.list'];
    expect(hasPermission(permissions, 'team.plugin.create', 'team.plugin.list')).toBe(true);
    expect(hasPermission(permissions, 'team.plugin.list', 'team.plugin.create')).toBe(true);
    expect(hasPermission(permissions, 'team.plugin.create', 'team.member.invite')).toBe(false);
  });

  it('ignores granted codes that were not requested', () => {
    const permissions = ['platform.user.list', 'team.balance.view', 'team.plugin.create'];
    expect(hasPermission(permissions, 'team.plugin.create')).toBe(true);
    expect(hasPermission(permissions, 'team.member.remove')).toBe(false);
  });

  it('matches codes exactly rather than by prefix', () => {
    expect(hasPermission(['team.plugin.list'], 'team.plugin')).toBe(false);
    expect(hasPermission(['team.plugin'], 'team.plugin.list')).toBe(false);
  });
});

describe('isTeamManager', () => {
  it('returns false for an empty permission set', () => {
    expect(isTeamManager([])).toBe(false);
  });

  it('returns false when only the three baseline read-only permissions are granted', () => {
    expect(isTeamManager(TEAM_BASELINE)).toBe(false);
    for (const code of TEAM_BASELINE) {
      expect(isTeamManager([code])).toBe(false);
    }
  });

  it('returns true when any managing team.* permission is granted', () => {
    expect(isTeamManager(['team.plugin.create'])).toBe(true);
    expect(isTeamManager([...TEAM_BASELINE, 'team.plugin.create'])).toBe(true);
    expect(isTeamManager([...TEAM_BASELINE, 'team.member.invite'])).toBe(true);
  });

  it('ignores non team.* permissions', () => {
    expect(isTeamManager(['platform.user.list'])).toBe(false);
    expect(isTeamManager(['teams.plugin.create'])).toBe(false);
    expect(isTeamManager(['plugin.create'])).toBe(false);
  });
});

describe('isPlatformManager', () => {
  it('returns false for an empty permission set', () => {
    expect(isPlatformManager([])).toBe(false);
  });

  it('returns true when any platform.* permission is granted', () => {
    expect(isPlatformManager(['platform.user.list'])).toBe(true);
    expect(isPlatformManager([...TEAM_BASELINE, 'platform.team.list'])).toBe(true);
  });

  it('returns false when only team permissions are granted', () => {
    expect(isPlatformManager([...TEAM_BASELINE, 'team.plugin.create'])).toBe(false);
  });

  it('ignores lookalike prefixes', () => {
    expect(isPlatformManager(['platformuser.list'])).toBe(false);
    expect(isPlatformManager(['platform'])).toBe(false);
  });
});
