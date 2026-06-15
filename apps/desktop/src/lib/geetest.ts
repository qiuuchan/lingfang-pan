// 极验 GeeTest V4 验证码 React hook（组C）。
//
// 用途：登录/注册/找回密码表单集成「点击验证」极验组件。后端配置了 geetestCaptchaId 时才渲染组件，
// 未配置时（开发态）hook 直接返回未就绪，调用方不传 captcha 参数（后端跳过校验）。
//
// 集成官方 gt4.js SDK（通过 <script> 标签动态加载，暴露全局 initGeetest4）。
// 流程：
//  1. loadGeetestScript：首次调用注入 https://static.geetest.com/v4/gt4.js（幂等，已加载不重复注入）。
//  2. initGeetest4({ captchaId, product:'bind', ... })：初始化组件，绑定到容器元素。
//  3. captchaObj.onSuccess：用户通过验证后读 4 参数（lot_number/captcha_output/pass_token/gen_time）存 state。
//  4. captchaObj.onClose / reset：用户关闭或重试时清空已存参数，强制重新验证。
//
// product:'bind' 模式：组件不直接渲染按钮，而是绑定到已有 DOM 元素（点击触发验证弹层），
// 与现有登录表单 UI 融合更自然（不引入额外按钮区域）。
import { useCallback, useEffect, useRef, useState } from 'react';

/** gt4.js SDK 地址（官方 CDN，固定版本路径）。 */
const GEETEST_SDK_URL = 'https://static.geetest.com/v4/gt4.js';
/** 已加载 SDK 的全局标记 key（避免重复注入 script 标签）。 */
const GEETEST_SCRIPT_LOADED = '__lf_geetest_sdk_loaded__';

/** 极验 V4 组件实例的最小类型（仅声明用到的方法/事件，避免引入第三方类型）。 */
interface GeetestCaptchaObj {
  onSuccess: (cb: () => void) => void;
  onClose: (cb: () => void) => void;
  onError: (cb: () => void) => void;
  getValidate: () => GeetestValidateResult | null;
  reset: () => void;
  destroy: () => void;
  appendTo: (el: HTMLElement | string) => void;
}

/** 极验 onSuccess 回调产出的 4 参数（getValidate 返回）。 */
export interface GeetestValidateResult {
  lot_number: string;
  captcha_output: string;
  pass_token: string;
  gen_time: string;
}

/** 全局 initGeetest4 函数签名（gt4.js 暴露在 window 上）。 */
type InitGeetest4 = (
  options: { captchaId: string; product: 'bind' },
  callback: (captchaObj: GeetestCaptchaObj) => void,
) => void;

/**
 * 动态加载极验 gt4.js SDK（幂等）。
 * 首次注入 <script src>，加载完成后标记 window[GEETEST_SCRIPT_LOADED]=true。
 * 已加载则直接 resolve，避免重复注入。
 */
export function loadGeetestScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const w = window as unknown as Record<string, unknown>;
  if (w[GEETEST_SCRIPT_LOADED] === true) return Promise.resolve();
  if (document.querySelector(`script[src="${GEETEST_SDK_URL}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GEETEST_SDK_URL;
    script.async = true;
    script.onload = () => {
      w[GEETEST_SCRIPT_LOADED] = true;
      resolve();
    };
    script.onerror = () => reject(new Error('极验 SDK 加载失败，请检查网络后重试'));
    document.head.appendChild(script);
  });
}

/**
 * 极验验证码 hook。
 * @param captchaId 后端 platform-info 返回的 geetestCaptchaId（空串=未配置，不初始化）。
 * @returns
 *  - containerRef：绑定到容器元素（极验组件挂载点）。
 *  - ready：组件已就绪（captchaId 非空 + SDK 加载完成 + 组件初始化完成）。
 *  - validateResult：用户通过验证后的 4 参数（null=未验证或已重置）。
 *  - reset：重置验证状态（提交失败后强制重新验证）。
 */
export function useGeetest(captchaId: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const captchaObjRef = useRef<GeetestCaptchaObj | null>(null);
  const [ready, setReady] = useState(false);
  const [validateResult, setValidateResult] = useState<GeetestValidateResult | null>(null);

  useEffect(() => {
    // 未配置 captchaId → 不初始化（开发态跳过），ready 保持 false。
    if (!captchaId) return;
    let cancelled = false;
    let captchaObj: GeetestCaptchaObj | null = null;

    loadGeetestScript()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const init = (window as unknown as { initGeetest4?: InitGeetest4 }).initGeetest4;
        if (!init) throw new Error('极验 SDK 未正确加载');
        init({ captchaId, product: 'bind' }, (obj) => {
          if (cancelled) {
            obj.destroy?.();
            return;
          }
          captchaObj = obj;
          captchaObjRef.current = obj;
          obj.appendTo(containerRef.current!);
          // 用户通过验证：读 4 参数存 state。
          obj.onSuccess(() => {
            const result = obj.getValidate();
            setValidateResult(result);
          });
          // 用户关闭验证弹层：清空已验证参数（下次需重新验证）。
          obj.onClose(() => {
            setValidateResult(null);
          });
          // 组件出错：清空参数，避免脏数据被提交。
          obj.onError(() => {
            setValidateResult(null);
          });
          setReady(true);
        });
      })
      .catch(() => {
        // SDK 加载失败不阻断登录流程（后端配置了极验但前端 SDK 加载失败时，
        // 用户无法完成验证，提交会被后端拒；此处仅保持 ready=false，调用方提示）。
        // 不抛错：避免 unhandled rejection 中断渲染。
      });

    return () => {
      cancelled = true;
      captchaObj?.destroy?.();
      captchaObjRef.current = null;
      setReady(false);
      setValidateResult(null);
    };
  }, [captchaId]);

  /** 重置验证状态（提交失败 / 用户改了邮箱后强制重新验证）。 */
  const reset = useCallback(() => {
    captchaObjRef.current?.reset?.();
    setValidateResult(null);
  }, []);

  return { containerRef, ready, validateResult, reset };
}
