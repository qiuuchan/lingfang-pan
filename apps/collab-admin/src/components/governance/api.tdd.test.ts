import { describe, expect, it } from 'vitest';

import { queryString, segment } from '@/components/governance/api';

// governance/api.ts 里的两个纯函数是所有治理接口 URL 的拼装基座：
// queryString 负责查询串序列化（含空值裁剪），segment 负责路径片段转义。
// 二者行为一旦漂移，所有 loadXxx 的请求地址都会静默出错，故在此固化边界语义。

describe('queryString', () => {
  it('空对象返回空串（不产生裸问号）', () => {
    expect(queryString({})).toBe('');
  });

  it('全部为 undefined 时返回空串', () => {
    expect(queryString({ search: undefined, status: undefined })).toBe('');
  });

  it('全部为空字符串时返回空串', () => {
    expect(queryString({ search: '', status: '' })).toBe('');
  });

  it('有值时以 ? 前缀开头', () => {
    expect(queryString({ page: 1 })).toBe('?page=1');
  });

  it('序列化默认分页参数', () => {
    expect(queryString({ page: 1, pageSize: 20 })).toBe('?page=1&pageSize=20');
  });

  it('保留字面量 0（0 不等于空串，不应被裁剪）', () => {
    expect(queryString({ page: 0, pageSize: 20 })).toBe('?page=0&pageSize=20');
  });

  it('数字被转成字符串', () => {
    expect(queryString({ pageSize: 100 })).toBe('?pageSize=100');
  });

  it('跳过 undefined / 空串，仅保留有效项', () => {
    expect(
      queryString({ page: 1, pageSize: 20, search: undefined, status: '', sourceKind: 'GIT' })
    ).toBe('?page=1&pageSize=20&sourceKind=GIT');
  });

  it('按对象键的插入顺序输出', () => {
    expect(queryString({ pageSize: 20, page: 2 })).toBe('?pageSize=20&page=2');
  });

  it('空格编码为 +（application/x-www-form-urlencoded 语义）', () => {
    expect(queryString({ search: 'hello world' })).toBe('?search=hello+world');
  });

  it('对 & = ? # 等分隔符做百分号编码，避免注入额外参数', () => {
    expect(queryString({ search: 'a&b=c' })).toBe('?search=a%26b%3Dc');
    expect(queryString({ search: 'a?b#c' })).toBe('?search=a%3Fb%23c');
  });

  it('斜杠与加号被编码，加号不会被误读为空格', () => {
    expect(queryString({ search: 'a/b+c' })).toBe('?search=a%2Fb%2Bc');
  });

  it('中文按 UTF-8 百分号编码', () => {
    expect(queryString({ search: '插件' })).toBe('?search=%E6%8F%92%E4%BB%B6');
  });

  it('键名同样被编码', () => {
    expect(queryString({ 'a b': 'c' })).toBe('?a+b=c');
  });

  it('仅空白字符的值不算空，会被保留', () => {
    expect(queryString({ search: ' ' })).toBe('?search=+');
  });

  it('多个字段以 & 连接', () => {
    expect(queryString({ page: 1, pageSize: 20, search: 'x', status: 'ACTIVE' })).toBe(
      '?page=1&pageSize=20&search=x&status=ACTIVE'
    );
  });
});

describe('segment', () => {
  it('普通 id 原样返回', () => {
    expect(segment('pkg-123')).toBe('pkg-123');
  });

  it('空串返回空串', () => {
    expect(segment('')).toBe('');
  });

  it('斜杠被编码，防止路径穿越', () => {
    expect(segment('a/b')).toBe('a%2Fb');
    expect(segment('../admin')).toBe('..%2Fadmin');
  });

  it('空格编码为 %20（路径语义，不是 +）', () => {
    expect(segment('a b')).toBe('a%20b');
  });

  it('查询串分隔符被编码，无法追加参数', () => {
    expect(segment('id?x=1')).toBe('id%3Fx%3D1');
    expect(segment('id#frag')).toBe('id%23frag');
  });

  it('中文按 UTF-8 百分号编码', () => {
    expect(segment('插件')).toBe('%E6%8F%92%E4%BB%B6');
  });

  it('encodeURIComponent 的非转义字符集保持原样', () => {
    expect(segment("-_.!~*'()")).toBe("-_.!~*'()");
  });

  it('百分号本身被转义，保证可逆', () => {
    expect(segment('100%')).toBe('100%25');
    expect(decodeURIComponent(segment('a/b c%d'))).toBe('a/b c%d');
  });
});

describe('URL 组合', () => {
  it('路径片段与查询串拼出完整地址', () => {
    const url = `/api/admin/plugin-packages/${segment('pkg 1')}/releases${queryString({
      page: 1,
      pageSize: 20,
    })}`;
    expect(url).toBe('/api/admin/plugin-packages/pkg%201/releases?page=1&pageSize=20');
  });

  it('无查询参数时不残留问号', () => {
    const url = `/api/admin/plugin-packages/${segment('pkg-1')}${queryString({
      search: undefined,
    })}`;
    expect(url).toBe('/api/admin/plugin-packages/pkg-1');
  });
});
