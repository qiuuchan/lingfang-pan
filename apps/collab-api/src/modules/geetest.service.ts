// 极验 GeeTest V4 验证码二次校验服务（组C）。
//
// 设计契约：
//  - validate(lot_number, captcha_output, pass_token, gen_time)：后端二次校验入口。
//    1) 读 PlatformSetting 的 geetestCaptchaId/geetestCaptchaKey（缓存，避免每次登录查库）。
//    2) 未配置 geetestCaptchaId（空）→ 直接返回 true（开发态跳过，前端不显验证码）。
//    3) 已配置 → sign_token = HMAC-SHA256(captchaKey, lot_number) hex，
//       POST https://gcaptcha4.geetest.com/validate?captcha_id=<id>（表单 5 参数）。
//    4) 极验返回 result==='success' → true；result!=='success' → false。
//    5) 极验 API 超时/异常/响应非 JSON → 返回 false + console.error 日志，
//       不伪造验证码成功；调用方按验证码失败处理。
//
// 缓存设计：getCaptchaConfig 内联缓存实例字段（首次查库）。配置变更时由 SettingsService.updateSettings
// 调 invalidateConfigCache 失效（与 mail.invalidateSmtpCache 同模式），admin 保存后即生效无需重启。
// 配置读取与 mail.service.getBrand 同模式（直接查 PlatformSetting 白名单 key，不注入 SettingsService 避免循环依赖）。
import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma.service';

/** 极验二次校验接口地址（官方固定，强制 HTTPS 以防中间人篡改 result 绕过人机校验）。
 *  captcha_id 作为 query 参数附在 URL 后，便于在网关/日志层按 id 识别异常请求。 */
const GEETEST_VALIDATE_URL = 'https://gcaptcha4.geetest.com/validate';

/** 二次校验请求超时（毫秒）。极验 API 正常响应 <1s，5s 兜底防网络黑洞挂起登录流程。 */
const GEETEST_TIMEOUT_MS = 5_000;

/** 极验配置缓存条目：值快照 + 加载标志。
 *  null 表示未加载（首次请求查库），加载后缓存 id/key/scenes（即便为空也缓存，避免每次空查询）。 */
interface GeetestConfig {
  captchaId: string;
  captchaKey: string;
  scenes: string[];
}

/** 前端回调产出的 4 个验证参数（gt4.js captchaObj.onSuccess 回调）。 */
export interface GeetestCaptchaParams {
  lot_number: string;
  captcha_output: string;
  pass_token: string;
  gen_time: string;
}

/** 极验支持的场景枚举（与 settings.service KEY_VALIDATORS.geetestScenes 的 SCENES 白名单一致）。
 *  admin_login/admin_forgot 分别对应管理端登录/管理端找回密码。 */
export type GeetestScene = 'admin_login' | 'admin_forgot';

function normalizeScene(item: string): GeetestScene | null {
  if (item === 'admin_login' || item === 'login') return 'admin_login';
  if (item === 'admin_forgot' || item === 'forgot') return 'admin_forgot';
  return null;
}

@Injectable()
export class GeetestService {
  /** 极验配置缓存（启动后变更需重启）。null=未加载。 */
  private configCache: GeetestConfig | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 二次校验：判定本次验证码是否有效。
   * @param params 前端回调产出的 4 参数（lot_number/captcha_output/pass_token/gen_time）。
   *   未配置极验时（开发态）params 可为 undefined，直接放行。
   * @returns true=通过，false=验证失败或极验二次校验不可用。
   *   调用方在「已配置极验 + params 缺失」时应自行抛 badRequest，本方法仅负责「配了就校验，校验失败返 false」。
   */
  async validate(params?: Partial<GeetestCaptchaParams>): Promise<boolean> {
    const config = await this.getCaptchaConfig();
    // 未配置极验（captchaId 空）→ 直接放行（开发态跳过，前端不显验证码）。
    if (!config.captchaId) return true;

    // 已配置极验：4 参数必须齐全，任一缺失视为未完成验证码。
    if (
      !params?.lot_number ||
      !params?.captcha_output ||
      !params?.pass_token ||
      !params?.gen_time
    ) {
      return false;
    }

    // 生成签名：HMAC-SHA256(captchaKey, lot_number) hex。
    // lot_number 作为消息，captchaKey 作为密钥（极验官方固定算法，与服务端 key 一致才能通过校验）。
    const sign_token = createHmac('sha256', config.captchaKey)
      .update(params.lot_number)
      .digest('hex');

    // 构造表单 5 参数（application/x-www-form-urlencoded）。
    const form = new URLSearchParams({
      lot_number: params.lot_number,
      captcha_output: params.captcha_output,
      pass_token: params.pass_token,
      gen_time: params.gen_time,
      sign_token,
    });
    const url = `${GEETEST_VALIDATE_URL}?captcha_id=${encodeURIComponent(config.captchaId)}`;

    try {
      // AbortController 兜底超时：极验挂起时不让登录流程无限等待。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEETEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      // 响应状态非 200 → 显式失败，不把外部异常伪造成验证码成功。
      if (!res.ok) {
        console.error('[geetest.validate] 极验响应状态异常', { status: res.status });
        return false;
      }
      const data = (await res.json()) as { result?: string; reason?: string };
      // 仅 result==='success' 视为通过；其余（fail 等）均返回 false，调用方提示「请先完成验证码」。
      return data.result === 'success';
    } catch (error) {
      // 网络异常/超时/响应非 JSON → 显式失败；不吞掉外部依赖错误。
      console.error('[geetest.validate] 极验二次校验异常', { error: (error as Error).message });
      return false;
    }
  }

  /** 失效极验配置缓存。由 SettingsService.updateSettings 在改了 geetestCaptchaId/geetestCaptchaKey/geetestScenes 后调用，
   *  保证 admin 保存后下一次管理端验证码校验即读到新配置（不依赖重启进程生效），与 mail.invalidateSmtpCache 同模式。
   *
   *  与「启动后变更需重启」的旧设计不同：admin 通过设置页改极验配置的频率虽低，但「改了不生效」会造成
   *  前端（platform-info 30s 缓存刷新后）已显示验证码、后端却仍按旧缓存状态跳过校验的不一致；统一在
   *  updateSettings 后失效缓存，使行为与 SMTP 热生效一致（admin 保存即生效）。 */
  invalidateConfigCache(): void {
    this.configCache = null;
  }

  /** 当前是否已配置极验（前端据此决定是否显示验证码）。
   *  供 platform-info 端点返回（与 getPublicInfo 合并查询，避免前端多次往返）。 */
  async isConfigured(): Promise<boolean> {
    const config = await this.getCaptchaConfig();
    return !!config.captchaId;
  }

  /** 指定场景是否启用极验校验（组C 场景开关）。
   *  - 未配置 captchaId（极验未启用）→ 任何场景都返回 false（不校验）。
   *  - 已配置但 scenes 为空 → 全部场景返回 false（即便配了 id/key 也不校验，admin 可临时关闭所有场景）。
   *  - scenes 含该场景 → true（该场景强制校验验证码）。
   *  AuthService.requireAdminCaptcha(scene) 据此决定是否跳过校验。 */
  async isSceneEnabled(scene: GeetestScene): Promise<boolean> {
    const config = await this.getCaptchaConfig();
    if (!config.captchaId) return false;
    return config.scenes.includes(scene);
  }

  /** 读取极验配置（PlatformSetting 缓存）。
   *  首次查库并缓存到实例字段；SettingsService.updateSettings 改 geetest key 后调 invalidateConfigCache 失效。
   *  即便 key 不存在也缓存空串/空数组（避免每次登录都查空），保证「未配置」判定稳定。 */
  private async getCaptchaConfig(): Promise<GeetestConfig> {
    if (this.configCache) return this.configCache;
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['geetestCaptchaId', 'geetestCaptchaKey', 'geetestScenes'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    // scenes 按「非空项 + 小写」解析；兼容旧 login/forgot 值并映射为管理端场景。
    const scenesRaw = map.get('geetestScenes') ?? '';
    const sceneSet = new Set(
      scenesRaw
        .split(',')
        .map((s) => normalizeScene(s.trim().toLowerCase()))
        .filter((s): s is GeetestScene => !!s)
    );
    const sceneOrder = ['admin_login', 'admin_forgot'] as const;
    const scenes: GeetestScene[] = sceneOrder.filter((s) => sceneSet.has(s));
    this.configCache = {
      captchaId: (map.get('geetestCaptchaId') ?? '').trim(),
      captchaKey: map.get('geetestCaptchaKey') ?? '',
      scenes,
    };
    return this.configCache;
  }
}
