// audit-actions 注册表单测（组D 审计完善）。
// 覆盖：
//  - auditActionCategory：前缀推断 + 显式覆盖表（platform_admin.bootstrap → system，user.account_deleted → auth）。
//  - auditActionLabel：已注册返回中文，未注册原样返回。
//  - AUDIT_CATEGORIES：8 个分类 key 齐全 + label 非空。
//  - 跨前缀归类：invitation.* / team_admin_application.* → team；plugin.marketplace.* → marketplace。
import { describe, expect, it } from 'vitest';
import { auditActionCategory, auditActionLabel, AUDIT_ACTION_LABEL, AUDIT_CATEGORIES } from './audit-actions';

describe('audit-actions 分类推断', () => {
  it('auth 前缀归 auth', () => {
    expect(auditActionCategory('auth.login.success')).toBe('auth');
    expect(auditActionCategory('auth.register')).toBe('auth');
    expect(auditActionCategory('auth.password.reset')).toBe('auth');
  });

  it('team 前缀归 team', () => {
    expect(auditActionCategory('team.balance.consumed')).toBe('team');
    expect(auditActionCategory('team.member.removed')).toBe('team');
  });

  it('invitation. 前缀归 team（跨前缀归类）', () => {
    expect(auditActionCategory('invitation.created')).toBe('team');
    expect(auditActionCategory('invitation.redeemed')).toBe('team');
  });

  it('team_admin_application. 前缀归 team（跨前缀归类）', () => {
    expect(auditActionCategory('team_admin_application.created')).toBe('team');
    expect(auditActionCategory('team_admin_application.approved')).toBe('team');
  });

  it('plugin 前缀归 plugin', () => {
    expect(auditActionCategory('plugin.uploaded')).toBe('plugin');
    expect(auditActionCategory('plugin.draft.edited')).toBe('plugin');
  });

  it('plugin.marketplace. 前缀归 marketplace（跨前缀归类，优先于 plugin）', () => {
    expect(auditActionCategory('plugin.marketplace.submitted')).toBe('marketplace');
    expect(auditActionCategory('plugin.marketplace.installed')).toBe('marketplace');
  });

  it('marketplace. 前缀归 marketplace', () => {
    expect(auditActionCategory('marketplace.plugin.installed')).toBe('marketplace');
  });

  it('wallet 前缀归 wallet', () => {
    expect(auditActionCategory('wallet.purchase')).toBe('wallet');
  });

  it('llm_binding. 前缀归 llm', () => {
    expect(auditActionCategory('llm_binding.upserted')).toBe('llm');
    expect(auditActionCategory('llm_binding.key_decrypted')).toBe('llm');
  });

  it('admin. 前缀归 admin', () => {
    expect(auditActionCategory('admin.user.created')).toBe('admin');
    expect(auditActionCategory('admin.plugin.approved')).toBe('admin');
  });

  it('admin.setting. 前缀归 system（跨前缀归类，优先于 admin）', () => {
    expect(auditActionCategory('admin.setting.updated')).toBe('system');
    expect(auditActionCategory('admin.setting.test_email')).toBe('system');
  });

  it('platform_admin.bootstrap 显式覆盖归 system（跨前缀归类）', () => {
    expect(auditActionCategory('platform_admin.bootstrap')).toBe('system');
  });

  it('user.account_deleted 显式覆盖归 auth（账号生命周期归身份范畴）', () => {
    expect(auditActionCategory('user.account_deleted')).toBe('auth');
  });

  it('未注册的未知 action 归 system（兜底）', () => {
    expect(auditActionCategory('some.unknown.action')).toBe('system');
    expect(auditActionCategory('totally_random')).toBe('system');
  });
});

describe('audit-actions 中文说明', () => {
  it('已注册 action 返回中文说明', () => {
    expect(auditActionLabel('auth.login.success')).toBe('登录成功');
    expect(auditActionLabel('plugin.uploaded')).toBe('上传插件');
    expect(auditActionLabel('admin.team.created')).toBe('创建团队');
  });

  it('未注册 action 原样返回（与前端 actionLabel 同款兜底）', () => {
    expect(auditActionLabel('some.unknown.action')).toBe('some.unknown.action');
  });

  it('所有已注册 action 都有非空中文说明', () => {
    // 遍历注册表，确保无空 label（防止注册时漏填说明）。
    for (const [action, label] of Object.entries(AUDIT_ACTION_LABEL)) {
      expect(label, `action ${action} 的 label 不应为空`).toBeTruthy();
      expect(label.trim().length, `action ${action} 的 label 不应仅空白`).toBeGreaterThan(0);
    }
  });
});

describe('AUDIT_CATEGORIES 元数据', () => {
  it('包含 8 个分类 key', () => {
    const keys = AUDIT_CATEGORIES.map((c) => c.key);
    expect(keys).toEqual(['auth', 'team', 'plugin', 'marketplace', 'wallet', 'llm', 'admin', 'system']);
  });

  it('每个分类有非空 label 与 description', () => {
    for (const cat of AUDIT_CATEGORIES) {
      expect(cat.label, `分类 ${cat.key} 的 label 不应为空`).toBeTruthy();
      expect(cat.description, `分类 ${cat.key} 的 description 不应为空`).toBeTruthy();
    }
  });
});
