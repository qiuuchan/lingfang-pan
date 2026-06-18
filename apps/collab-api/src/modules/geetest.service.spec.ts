// GeetestService 单测：覆盖未配置放行、签名生成、极验成功/失败判定、外部异常显式失败。
//  - unconfigured_returns_true（未配置 captchaId，开发态跳过）。
//  - missing_params_returns_false（已配置但 params 缺失 → false）。
//  - success_when_geetest_returns_success（极验 result==='success' → true）。
//  - failure_when_geetest_returns_fail（极验 result!=='success' → false）。
//  - network_error_returns_false（网络异常显式返回 false，不伪造验证码成功）。
//  - non_200_status_returns_false（响应非 200 显式返回 false）。
//  - sign_token_uses_hmac_sha256（签名算法正确，与极验官方一致）。
//  - is_configured_reads_captcha_id（isConfigured 据 captchaId 非空判定）。
// 参考 settings.service.spec.ts：Mock PrismaService，不连真实 DB；fetch 用 vi.stubGlobal mock。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { GeetestService } from './geetest.service';

function mockPrisma(rows: Array<{ key: string; value: string }> = []) {
  return {
    platformSetting: {
      findMany: vi.fn(async () => rows),
    },
  };
}

/** mock fetch：返回指定状态码与 JSON body 的 Response-like 对象。
 *  GeetestService 仅读 res.ok / res.json()，故构造最小 Response 形状即可。 */
function mockFetch(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  return vi.fn(async () => response as Response);
}

describe('GeetestService', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('未配置 captchaId 时直接放行（开发态跳过）', async () => {
    const prisma = mockPrisma([]);
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    const service = new GeetestService(prisma);
    expect(await service.validate()).toBe(true);
    // isConfigured 也应为 false。
    expect(await service.isConfigured()).toBe(false);
  });

  it('已配置但 4 参数缺失时返回 false', async () => {
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    const fetchFn = mockFetch({ ok: true, status: 200, json: async () => ({ result: 'success' }) });
    vi.stubGlobal('fetch', fetchFn);
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    expect(await service.validate({ lot_number: 'x', captcha_output: '', pass_token: '', gen_time: '' })).toBe(false);
    // 缺参不应发起极验请求。
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('极验返回 result===success 时通过', async () => {
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    const fetchFn = mockFetch({ ok: true, status: 200, json: async () => ({ result: 'success' }) });
    vi.stubGlobal('fetch', fetchFn);
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    const ok = await service.validate({
      lot_number: 'lot123',
      captcha_output: 'out',
      pass_token: 'pt',
      gen_time: 'gt',
    });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // URL 含 captcha_id query 参数。
    const calledUrl = String(fetchFn.mock.calls[0][0]);
    expect(calledUrl).toContain('captcha_id=fake-id');
    // 请求体含 5 参数（含 sign_token）。
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    const body = String(init.body);
    expect(body).toContain('lot_number=lot123');
    expect(body).toContain('sign_token=');
    // Content-Type 为表单。
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('极验返回 result!==success 时拒绝', async () => {
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    vi.stubGlobal('fetch', mockFetch({ ok: true, status: 200, json: async () => ({ result: 'fail', reason: 'fake' }) }));
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    const ok = await service.validate({ lot_number: 'lot', captcha_output: 'o', pass_token: 'p', gen_time: 'g' });
    expect(ok).toBe(false);
  });

  it('网络异常时返回 false（不伪造验证码成功）', async () => {
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    const ok = await service.validate({ lot_number: 'lot', captcha_output: 'o', pass_token: 'p', gen_time: 'g' });
    expect(ok).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('响应状态非 200 时返回 false（+ 记日志）', async () => {
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503, json: async () => ({}) }));
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    const ok = await service.validate({ lot_number: 'lot', captcha_output: 'o', pass_token: 'p', gen_time: 'g' });
    expect(ok).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('sign_token 使用 HMAC-SHA256(captchaKey, lot_number)（与极验官方算法一致）', async () => {
    const captchaKey = 'fake-key';
    const lotNumber = 'lot-abc';
    const expectedSign = createHmac('sha256', captchaKey).update(lotNumber).digest('hex');
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: captchaKey },
    ]);
    const fetchFn = mockFetch({ ok: true, status: 200, json: async () => ({ result: 'success' }) });
    vi.stubGlobal('fetch', fetchFn);
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    await service.validate({ lot_number: lotNumber, captcha_output: 'o', pass_token: 'p', gen_time: 'g' });
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    const body = String(init.body);
    expect(body).toContain(`sign_token=${expectedSign}`);
  });

  it('isConfigured 据 captchaId 非空判定（空 value 视为未配置）', async () => {
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: '   ' }, // 空白视为未配置
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    expect(await service.isConfigured()).toBe(false);
  });

  it('isConfigured 返回 true（captchaId 非空）', async () => {
    const prisma = mockPrisma([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    expect(await service.isConfigured()).toBe(true);
  });

  // 组C 缓存失效：invalidateConfigCache 后下次读取重新查库（SettingsService.updateSettings 调用）。
  it('invalidateConfigCache 后下次读取重新查库（admin 改极验配置即生效）', async () => {
    const findMany = vi.fn(async () => [
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    const prisma = { platformSetting: { findMany } };
    // @ts-expect-error mock
    const service = new GeetestService(prisma);
    // 首次读取查库 + 缓存。
    await service.isConfigured();
    expect(findMany).toHaveBeenCalledTimes(1);
    // 第二次命中缓存（不查库）。
    await service.isConfigured();
    expect(findMany).toHaveBeenCalledTimes(1);
    // 失效后第三次重新查库。
    service.invalidateConfigCache();
    await service.isConfigured();
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
