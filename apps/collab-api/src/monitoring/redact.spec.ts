import { describe, expect, it } from 'vitest';
import { REDACTED, redactContext, scrubObject } from './redact';

describe('脱敏层 (redact)', () => {
  it('反向：Authorization Bearer JWT 被整体剥离（不含 eyJ 子串）', () => {
    const ctx = {
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' },
      requestId: 'req-1',
    };
    const out = redactContext(ctx) as { headers: { authorization: string } };
    expect(out.headers.authorization).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('eyJ');
  });

  it('反向：明文 password / apiKey 字段被整体替换', () => {
    const ctx = { body: { password: 's3cret', apiKey: 'AKIA-1234567890' }, teamId: 't1' };
    const out = redactContext(ctx) as { body: { password: string; apiKey: string } };
    expect(out.body.password).toBe(REDACTED);
    expect(out.body.apiKey).toBe(REDACTED);
  });

  it('反向：长十六进制密钥形态被脱敏', () => {
    const ctx = { key: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' };
    const out = redactContext(ctx) as { key: string };
    expect(out.key).toBe(REDACTED);
  });

  it('正向：普通业务字段原样保留', () => {
    const ctx = { teamId: 'team-9', orderId: 'ord-42', method: 'POST' };
    const out = redactContext(ctx);
    expect(out).toEqual(ctx);
  });

  it('正向：嵌套对象的非敏感字段保留，敏感字段剥离', () => {
    const ctx = { user: { id: 'u1', email: 'a@b.com', token: 'eyJabc' } };
    const out = scrubObject(ctx) as { user: { id: string; email: string; token: string } };
    expect(out.user.id).toBe('u1');
    expect(out.user.email).toBe('a@b.com');
    expect(out.user.token).toBe(REDACTED);
  });
});
