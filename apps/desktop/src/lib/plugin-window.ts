// plugin-window.ts — 多窗口（Task 15）：把插件弹出到独立 Tauri 窗口运行。
//
// 用 WebviewWindow 创建 label=plugin-<id> 的独立窗口，URL 带 ?standalone=1&plugin=<id>。
// App 启动检测到该 query 时渲染 StandalonePluginRunner（无侧栏/标题栏，仅插件本体）。
// 同 label 窗口已存在则聚焦而非重复创建（一插件一窗口）。
//
// 浏览器 dev（无 Tauri 壳）降级为新标签页打开（便于调试）。
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { LoadedPlugin } from '@/lib/types';

const hasTauri = typeof window !== 'undefined'
  && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

function pluginWindowLabel(pluginId: string): string {
  // WebviewWindow label 仅允许 [a-zA-Z0-9-:/]，id 已是 kebab-case 安全。
  return `plugin-${pluginId}`;
}

/** 把插件在新窗口打开（独立运行）。已存在则聚焦。无 Tauri 壳时降级新标签页。 */
export async function openPluginInWindow(plugin: LoadedPlugin): Promise<void> {
  const url = `index.html?standalone=1&plugin=${encodeURIComponent(plugin.id)}`;
  const label = pluginWindowLabel(plugin.id);

  if (!hasTauri) {
    // dev 浏览器降级：新标签页（不传 session，但 dev 下 index.html 同源共享 localStorage）。
    window.open(url, `_blank_${label}`);
    return;
  }

  // 已存在则聚焦 + 取消最小化。
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    try {
      await existing.setFocus();
      await existing.unminimize();
    } catch {
      /* 聚焦失败忽略（窗口可能正在关闭） */
    }
    return;
  }

  const title = `${plugin.name} — 灵坊工作台`;
  // 用户代理分区的 webview 共享主窗口的 localStorage（同源），session token 可用。
  try {
    const webview = new WebviewWindow(label, {
      url,
      title,
      width: 960,
      height: 720,
      minWidth: 480,
      minHeight: 360,
      resizable: true,
      decorations: true,
    });
    // 监听创建错误事件（WebviewWindow 构造不抛同步异常，能力缺失/URL 非法通过 error 事件上报）。
    // once 创建后即解绑，不长期占用。
    try {
      webview.once('tauri://error', (event) => {
        const msg = (event?.payload as { message?: string } | undefined)?.message || String(event?.payload ?? '未知错误');
        import('sonner').then(({ toast }) => toast.error(`独立窗口创建失败：${msg}`)).catch(() => void 0);
      });
    } catch {
      /* once 注册失败忽略 */
    }
  } catch (error) {
    // 创建失败（能力缺失/被拒）抛给调用方 toast。
    throw new Error(`无法打开独立窗口：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 当前窗口是否处于 standalone 插件模式（URL 带 standalone=1）。 */
export function isStandalonePluginWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('standalone') === '1';
}

/** standalone 模式下要加载的插件 id（URL ?plugin=）。 */
export function standalonePluginId(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get('plugin');
  return id || null;
}

/** 关闭当前窗口（standalone 插件窗口的「关闭」按钮用）。主窗口不应调用。 */
export async function closeCurrentWindow(): Promise<void> {
  if (!hasTauri) {
    window.close();
    return;
  }
  try {
    await getCurrentWindow().close();
  } catch {
    /* 忽略 */
  }
}
