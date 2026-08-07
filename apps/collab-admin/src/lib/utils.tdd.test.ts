import { describe, it, expect } from 'vitest';
import { cn, money } from '@/lib/utils';

describe('cn', () => {
  it('无参数时返回空字符串', () => {
    expect(cn()).toBe('');
  });

  it('忽略 undefined / null / false / 空串等假值', () => {
    expect(cn(undefined, null, false, '')).toBe('');
    expect(cn('text-sm', undefined, null, false, '')).toBe('text-sm');
  });

  it('拼接多个不冲突的类名并保持顺序', () => {
    expect(cn('text-sm', 'font-bold')).toBe('text-sm font-bold');
  });

  it('同一 tailwind 属性冲突时后者胜出（px-2 + px-4 只留 px-4）', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('冲突去重只影响冲突项，其余类名保留', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });

  it('不同断点前缀不算冲突，两者都保留', () => {
    expect(cn('px-2', 'md:px-4')).toBe('px-2 md:px-4');
  });

  it('支持对象语法，仅保留值为真的键', () => {
    expect(cn({ 'text-sm': true, hidden: false })).toBe('text-sm');
    expect(cn('text-sm', { 'font-bold': true })).toBe('text-sm font-bold');
  });

  it('display 类互相冲突（block + hidden 只留 hidden）', () => {
    expect(cn('block', 'hidden')).toBe('hidden');
  });

  it('对象语法同样参与冲突去重', () => {
    expect(cn('px-2', { 'px-4': true })).toBe('px-4');
    expect(cn('px-2', { 'px-4': false })).toBe('px-2');
  });

  it('支持数组与嵌套数组', () => {
    expect(cn(['text-sm', 'font-bold'])).toBe('text-sm font-bold');
    expect(cn(['px-2', ['px-4']])).toBe('px-4');
  });

  it('重复的相同类名会被折叠为一个', () => {
    expect(cn('text-sm', 'text-sm')).toBe('text-sm');
  });
});

describe('money', () => {
  it('0 分格式化为 ¥0.00', () => {
    expect(money(0)).toBe('¥0.00');
  });

  it('负零不显示负号', () => {
    expect(money(-0)).toBe('¥0.00');
  });

  it('不足一元时补齐两位小数', () => {
    expect(money(1)).toBe('¥0.01');
    expect(money(50)).toBe('¥0.50');
  });

  it('整元金额保留两位小数', () => {
    expect(money(100)).toBe('¥1.00');
    expect(money(1000)).toBe('¥10.00');
  });

  it('带角分的金额正确换算', () => {
    expect(money(199)).toBe('¥1.99');
    expect(money(12345)).toBe('¥123.45');
  });

  it('负号前置到货币符号之前', () => {
    expect(money(-500)).toBe('-¥5.00');
    expect(money(-1)).toBe('-¥0.01');
  });

  it('负数不产生 ¥- 这种写法', () => {
    expect(money(-500)).not.toContain('¥-');
    expect(money(-500).startsWith('-¥')).toBe(true);
  });

  it('大额金额不使用千分位分隔符', () => {
    expect(money(123456789)).toBe('¥1234567.89');
    expect(money(-123456789)).toBe('-¥1234567.89');
  });

  it('正负同额只差一个前置负号', () => {
    expect(money(-8888)).toBe(`-${money(8888)}`);
  });
});
