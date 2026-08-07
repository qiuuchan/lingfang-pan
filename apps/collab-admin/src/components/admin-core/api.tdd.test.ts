import { describe, expect, it } from 'vitest';

import { endpoint, unwrapEntity } from '@/components/admin-core/api';

// admin-core/api 的两个纯函数单测。
// 这两个函数是整个后台列表/详情请求的公共底座：endpoint 负责查询串拼接，
// unwrapEntity 负责兼容后端「裸实体」与「{user}/{role} 包装」两种响应形状。
// 它们不发请求、不碰 DOM，可在 jsdom 下直接断言。

describe('endpoint', () => {
  it('无查询参数时返回原始 path，不带 ?', () => {
    expect(endpoint('/api/admin/users')).toBe('/api/admin/users');
  });

  it('查询对象为空时同样不带 ?', () => {
    expect(endpoint('/api/admin/users', {})).toBe('/api/admin/users');
  });

  it('单个参数拼接成 ?k=v', () => {
    expect(endpoint('/api/admin/users', { page: 1 })).toBe('/api/admin/users?page=1');
  });

  it('多个参数按插入顺序用 & 连接', () => {
    expect(endpoint('/api/admin/users', { page: 2, pageSize: 20, q: 'bob' })).toBe(
      '/api/admin/users?page=2&pageSize=20&q=bob'
    );
  });

  it('跳过 null / undefined / 空串，只保留有效参数', () => {
    expect(
      endpoint('/api/admin/users', {
        page: 1,
        q: '',
        status: null,
        role: undefined,
        pageSize: 10,
      })
    ).toBe('/api/admin/users?page=1&pageSize=10');
  });

  it('所有参数都被跳过时退化为无 ? 的 path', () => {
    expect(endpoint('/api/admin/roles', { q: '', status: null, cursor: undefined })).toBe(
      '/api/admin/roles'
    );
  });

  it('保留 0 与 false —— 它们是有效值，不应被当作空值跳过', () => {
    expect(endpoint('/api/admin/teams', { page: 0, archived: false })).toBe(
      '/api/admin/teams?page=0&archived=false'
    );
  });

  it('对特殊字符做 URL 编码，避免拼出非法查询串', () => {
    expect(endpoint('/api/admin/users/options', { q: 'a&b=c' })).toBe(
      '/api/admin/users/options?q=a%26b%3Dc'
    );
  });

  it('空格按 application/x-www-form-urlencoded 编码为 +', () => {
    expect(endpoint('/api/admin/users/options', { q: 'jane doe' })).toBe(
      '/api/admin/users/options?q=jane+doe'
    );
  });

  it('支持模板化的动态 path', () => {
    expect(endpoint('/api/admin/users/u-1/logins', { page: 3, pageSize: 50 })).toBe(
      '/api/admin/users/u-1/logins?page=3&pageSize=50'
    );
  });

  it('同名 key 只保留一次（用 set 而非 append）', () => {
    expect(endpoint('/api/admin/users', { page: 1 })).toBe('/api/admin/users?page=1');
    expect(endpoint('/api/admin/users', { page: 1 }).match(/page=/g)).toHaveLength(1);
  });

  it('不修改传入的 query 对象', () => {
    const query = { page: 1, q: '' };
    endpoint('/api/admin/users', query);
    expect(query).toEqual({ page: 1, q: '' });
  });
});

describe('unwrapEntity', () => {
  it('从 { user } 包装中解包出实体', () => {
    const user = { id: 'u-1', name: 'Bob' };
    expect(unwrapEntity({ user })).toBe(user);
  });

  it('从 { role } 包装中解包出实体', () => {
    const role = { id: 'r-1', name: 'admin' };
    expect(unwrapEntity({ role })).toBe(role);
  });

  it('user 键存在但值为 undefined 时，解包结果就是 undefined', () => {
    expect(unwrapEntity({ user: undefined })).toBeUndefined();
  });

  it('role 键存在但值为 undefined 时，解包结果就是 undefined', () => {
    expect(unwrapEntity({ role: undefined })).toBeUndefined();
  });

  it('user 键存在但值为 null 时，解包结果就是 null', () => {
    expect(unwrapEntity({ user: null })).toBeNull();
  });

  it('user 与 role 同时存在时，user 优先', () => {
    const user = { id: 'u-1' };
    const role = { id: 'r-1' };
    expect(unwrapEntity({ user, role })).toBe(user);
  });

  it('裸实体（无 user/role 键）原样返回', () => {
    const entity = { id: 'u-1', name: 'Bob' };
    expect(unwrapEntity(entity)).toBe(entity);
  });

  it('空对象原样返回', () => {
    const empty = {};
    expect(unwrapEntity(empty)).toBe(empty);
  });

  it('数组原样返回，不会被误判为包装对象', () => {
    const list = [{ id: 'u-1' }];
    expect(unwrapEntity(list)).toBe(list);
  });

  // 回归：`'user' in null` / `'user' in 'str'` 在 JS 中会抛 TypeError，
  // 实现必须先做 `payload && typeof payload === 'object'` 守卫。
  it('payload 为 null 时不抛错，原样返回 null', () => {
    expect(() => unwrapEntity(null)).not.toThrow();
    expect(unwrapEntity(null)).toBeNull();
  });

  it('payload 为 undefined 时不抛错，原样返回 undefined', () => {
    expect(() => unwrapEntity(undefined)).not.toThrow();
    expect(unwrapEntity(undefined)).toBeUndefined();
  });

  it('原始类型 payload 不抛错，原样返回', () => {
    expect(() => unwrapEntity('plain')).not.toThrow();
    expect(unwrapEntity('plain')).toBe('plain');
    expect(unwrapEntity(0)).toBe(0);
    expect(unwrapEntity(false)).toBe(false);
  });

  it('不修改传入的包装对象', () => {
    const payload = { user: { id: 'u-1' } };
    unwrapEntity(payload);
    expect(payload).toEqual({ user: { id: 'u-1' } });
  });
});
