import { describe, it, expect } from 'vitest';
import { formatSize, formatDate, absoluteDownloadUrl, PLATFORM_META } from '@/lib/releases';

// releases.ts 纯逻辑回归测试（边界值向）。
// 与 __tests__/pure-utils.test.ts 互补：那边覆盖「典型值」冒烟，
// 这里专攻边界与易回归点（falsy 收敛、KB/MB 阈值、toFixed 取整方向、
// 本地时区跨年、协议前缀大小写不敏感、平台元数据契约）。
// 断言一律以 releases.ts 当前实现行为为准，不表达「应该怎样」的期望。
// 运行：node_modules/.bin/vitest run src/lib/releases.tdd.test.ts

describe('formatSize 边界（falsy 收敛）', () => {
  it('所有 falsy 输入（含 0 / NaN）统一返回空串', () => {
    // 实现用 `if (!bytes) return ''`，NaN 是 falsy，故与 null/0 同路径。
    expect(formatSize(null)).toBe('');
    expect(formatSize(undefined)).toBe('');
    expect(formatSize(0)).toBe('');
    expect(formatSize(NaN)).toBe('');
  });

  it('负数不被特殊处理，按 KB 分支带负号输出', () => {
    // 记录现状：实现无负值守卫，-1/1024 → -0.0009…，toFixed(0) 得 "-0"。
    expect(formatSize(-1)).toBe('-0 KB');
    expect(formatSize(-2048)).toBe('-2 KB');
  });
});

describe('formatSize 阈值（KB / MB 分界）', () => {
  it('1 字节起即进入 KB 分支，四舍五入到整数 KB', () => {
    expect(formatSize(1)).toBe('0 KB');
    expect(formatSize(511)).toBe('0 KB'); // 0.499… → 向下舍到 0
    expect(formatSize(512)).toBe('1 KB'); // 0.5 → 半值进位到 1
    expect(formatSize(1023)).toBe('1 KB'); // 0.999… → 1，不是 "1023 B"
  });

  it('1MB 是 KB/MB 的分界：小于取 KB，等于取 MB', () => {
    expect(formatSize(1024 * 1024 - 1)).toBe('1024 KB'); // 仍在 KB 分支，可得 1024 KB
    expect(formatSize(1024 * 1024)).toBe('1.0 MB'); // 边界值走 MB 分支
  });

  it('MB 分支保留一位小数并四舍五入', () => {
    expect(formatSize(1310720)).toBe('1.3 MB'); // 1.25 → 进位
    expect(formatSize(1572864)).toBe('1.5 MB');
    expect(formatSize(157286400)).toBe('150.0 MB'); // 整数值也补 .0
  });
});

describe('formatDate 边界（空值与非法值）', () => {
  it('null / undefined / 空串在 falsy 守卫处直接返回空串', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
  });

  it('不可解析的字符串与 Invalid Date 对象返回空串', () => {
    // Date 对象恒为 truthy，走的是 Number.isNaN(getTime()) 这条守卫。
    expect(formatDate('not-a-date')).toBe('');
    expect(formatDate('2026-13-45')).toBe('');
    expect(formatDate(new Date(NaN))).toBe('');
  });
});

describe('formatDate 格式化（本地时区，YYYY-MM-DD）', () => {
  // 实现取 getFullYear/getMonth/getDate（本地时区），
  // 故断言一律用本地构造的 Date 或无偏移量的日期时间串，避免测试随 TZ 漂移。
  it('月 / 日补零到两位', () => {
    expect(formatDate(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
    expect(formatDate(new Date(2026, 8, 9, 12, 0, 0))).toBe('2026-09-09');
  });

  it('月份基于 getMonth()+1，12 月不会溢出成 13', () => {
    expect(formatDate(new Date(2026, 11, 25, 12, 0, 0))).toBe('2026-12-25');
  });

  it('跨年边界：本地 12-31 深夜与 01-01 凌晨各归各年', () => {
    expect(formatDate(new Date(2025, 11, 31, 23, 59, 59))).toBe('2025-12-31');
    expect(formatDate(new Date(2026, 0, 1, 0, 0, 1))).toBe('2026-01-01');
    // 无偏移量的 ISO date-time 串按本地时间解析，结论同上。
    expect(formatDate('2025-12-31T23:59:59')).toBe('2025-12-31');
    expect(formatDate('2026-01-01T00:00:01')).toBe('2026-01-01');
  });

  it('接受 Date 对象与 ISO 字符串两种入参且结果一致', () => {
    const d = new Date(2026, 5, 14, 10, 30, 0);
    expect(formatDate(d)).toBe('2026-06-14');
    expect(formatDate('2026-06-14T10:30:00')).toBe(formatDate(d));
  });
});

describe('absoluteDownloadUrl 协议判定（大小写不敏感）', () => {
  // 相对路径会被拼上 apiBase()，测试环境下的具体基址不写死，
  // 用空串探测出来复用，保证不依赖 VITE_API_BASE_URL 配置。
  const base = absoluteDownloadUrl('');

  it('http / https 绝对地址原样返回，且协议大小写不影响判定', () => {
    expect(absoluteDownloadUrl('http://a.com/x.exe')).toBe('http://a.com/x.exe');
    expect(absoluteDownloadUrl('https://a.com/x.exe')).toBe('https://a.com/x.exe');
    expect(absoluteDownloadUrl('HTTPS://a.com/x.exe')).toBe('HTTPS://a.com/x.exe');
    expect(absoluteDownloadUrl('HtTp://a.com/x.dmg')).toBe('HtTp://a.com/x.dmg');
  });

  it('非 http(s) 协议与协议相对地址不被识别为绝对地址，会被拼接基址', () => {
    // 记录现状：正则只认 ^https?://，其余一律当相对路径处理。
    expect(absoluteDownloadUrl('ftp://a.com/x.exe')).toBe(`${base}ftp://a.com/x.exe`);
    expect(absoluteDownloadUrl('//a.com/x.exe')).toBe(`${base}//a.com/x.exe`);
    expect(absoluteDownloadUrl('https:/a.com/x.exe')).toBe(`${base}https:/a.com/x.exe`);
  });

  it('协议必须在串首，前置空白会导致按相对路径拼接', () => {
    expect(absoluteDownloadUrl(' https://a.com/x.exe')).toBe(`${base} https://a.com/x.exe`);
  });

  it('相对路径拼在基址之后，且原路径被完整保留在尾部', () => {
    const out = absoluteDownloadUrl('/downloads/lingfang_1.0.0_x64.exe');
    expect(out).toBe(`${base}/downloads/lingfang_1.0.0_x64.exe`);
    expect(out.endsWith('/downloads/lingfang_1.0.0_x64.exe')).toBe(true);
    // 空串是退化输入：结果就是基址本身，不会引入多余斜杠。
    expect(absoluteDownloadUrl('')).toBe(base);
  });
});

describe('PLATFORM_META 平台元数据契约', () => {
  it('恰好覆盖 ReleaseAsset.platform 的三个取值，不多不少', () => {
    expect(Object.keys(PLATFORM_META).sort()).toEqual(['DARWIN', 'LINUX', 'WINDOWS']);
  });

  it('每个平台的 label / arch / ext 均为非空字符串', () => {
    for (const [key, meta] of Object.entries(PLATFORM_META)) {
      expect(meta.label, key).toBeTruthy();
      expect(meta.arch, key).toBeTruthy();
      expect(meta.ext, key).toBeTruthy();
    }
  });

  it('各平台展示文案与安装包扩展名与实现一致', () => {
    expect(PLATFORM_META.WINDOWS).toEqual({ label: 'Windows', arch: 'x64', ext: '.exe' });
    expect(PLATFORM_META.DARWIN).toEqual({
      label: 'macOS',
      arch: 'Apple Silicon / Intel',
      ext: '.dmg',
    });
    expect(PLATFORM_META.LINUX).toEqual({
      label: 'Linux',
      arch: 'x64 / arm64',
      ext: '.AppImage / .deb',
    });
  });

  it('扩展名均以点开头（下载按钮直接拼文案，缺点号会显示错误）', () => {
    for (const meta of Object.values(PLATFORM_META)) {
      expect(meta.ext.startsWith('.')).toBe(true);
    }
  });
});
