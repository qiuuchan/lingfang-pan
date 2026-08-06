import { describe, it, expect } from 'vitest';
import { money, cn } from '@/lib/utils';
import { formatSize, formatDate, absoluteDownloadUrl } from '@/lib/releases';
import { formatBytes } from '@/lib/tickets';
import { isPlatformAdminSession } from '@/lib/api';

// 管理前端纯函数单测基座。
// 这些函数都是确定性、无副作用的导出函数，是回归防护的高价值目标，
// 也作为后续组件/集成测试的范本。运行：pnpm -C apps/collab-admin test

describe('money (人民币分 -> 展示)', () => {
  it('0 分展示为 ¥0.00', () => {
    expect(money(0)).toBe('¥0.00');
  });
  it('整数分正确除以 100 并两位补零', () => {
    expect(money(100)).toBe('¥1.00');
    expect(money(10000)).toBe('¥100.00');
    expect(money(12345)).toBe('¥123.45');
    expect(money(999999)).toBe('¥9999.99');
  });
  it('负值保留负号', () => {
    expect(money(-500)).toBe('-¥5.00');
  });
});

describe('cn (className 合并)', () => {
  it('拼接多个类名', () => {
    expect(cn('a', 'b')).toBe('a b');
  });
  it('合并冲突的 tailwind 原子类（后者覆盖前者）', () => {
    const out = cn('px-2', 'px-4');
    expect(out).toContain('px-4');
    expect(out).not.toContain('px-2');
  });
  it('忽略 falsy 值', () => {
    expect(cn(false && 'x', undefined, 'y', '')).toBe('y');
  });
});

describe('formatSize (字节 -> 体积文案)', () => {
  it('空值返回空串', () => {
    expect(formatSize(null)).toBe('');
    expect(formatSize(undefined)).toBe('');
    expect(formatSize(0)).toBe('');
  });
  it('小于 1MB 以 KB 计（向下取整到 KB）', () => {
    expect(formatSize(500)).toBe('0 KB');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('2 KB');
  });
  it('大于等于 1MB 以 MB 计（一位小数）', () => {
    expect(formatSize(1048576)).toBe('1.0 MB');
    expect(formatSize(2097152)).toBe('2.0 MB');
  });
});

describe('formatDate (ISO -> YYYY-MM-DD)', () => {
  it('空值返回空串', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
  });
  it('非法日期返回空串', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
  it('合法日期返回 YYYY-MM-DD 形态', () => {
    expect(formatDate('2026-06-14T10:00:00Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatBytes (字节 -> 体积文案, tickets)', () => {
  it('小于 1KB 以 B 计', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });
  it('1KB~1MB 以 KB 计（一位小数）', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
  it('大于等于 1MB 以 MB 计', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });
});

describe('absoluteDownloadUrl (相对/绝对 URL 归一)', () => {
  it('已经是绝对 URL 则原样返回', () => {
    expect(absoluteDownloadUrl('https://cdn.example.com/x.exe')).toBe('https://cdn.example.com/x.exe');
  });
  it('相对路径拼到 API 基址前', () => {
    const out = absoluteDownloadUrl('/downloads/x.AppImage');
    expect(out).toMatch(/^https?:\/\//);
    expect(out.endsWith('/downloads/x.AppImage')).toBe(true);
  });
});

describe('isPlatformAdminSession (RBAC 谓词)', () => {
  it('null/空 session 不是平台管理员', () => {
    expect(isPlatformAdminSession(null)).toBe(false);
  });
  it('platformRole 为 PLATFORM_ADMIN 才为真', () => {
    expect(isPlatformAdminSession({ user: { platformRole: 'PLATFORM_ADMIN' } } as never)).toBe(true);
  });
  it('租户管理员/普通用户/缺字段均为假', () => {
    expect(isPlatformAdminSession({ user: { platformRole: 'TENANT_ADMIN' } } as never)).toBe(false);
    expect(isPlatformAdminSession({ user: {} } as never)).toBe(false);
  });
});
