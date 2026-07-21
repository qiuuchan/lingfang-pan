// SchedulerNotifier.tsx —— 本地定时任务通知分发（PRD R7）。
//
// 监听 Rust 端 emit 的 `scheduler:notify` { title, body } 事件：
// 1. 应用内 toast（sonner Toaster）：任何状态都显示（透明优先）。
// 2. 系统通知（tauri-plugin-notification）：尊重勿扰时段（lf:dnd-window）。
//
// 勿扰时段格式：localStorage `lf:dnd-window` = "HH:MM-HH:MM"（如 "23:00-07:00"）。
// 该时段仅 toast，不发系统通知；用户可在设置页配置（MVP 直接 localStorage 写入）。
import { useEffect } from 'react';
import { toast } from 'sonner';
import { tauriListen } from '@/lib/api';

const DND_STORAGE = 'lf:dnd-window';

interface SchedulerNotifyPayload {
  title: string;
  body: string;
}

export function SchedulerNotifier() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await tauriListen<SchedulerNotifyPayload>(
        'scheduler:notify',
        async (event) => {
          const { title, body } = event.payload;
          // 1. 应用内 toast（任何状态都显示）。
          // 标题前缀 [定时任务] 由 Rust 端已加；按内容判断 level。
          const isFailure = title.includes('失败') || title.includes('超时') || title.includes('跳过');
          if (isFailure) {
            toast.error(title, { description: body || undefined, duration: 10000 });
          } else {
            toast.success(title, { description: body || undefined, duration: 6000 });
          }

          // 2. 系统通知（尊重勿扰时段）。
          if (!isInDndWindow()) {
            try {
              await sendSystemNotification(title, body);
            } catch (e) {
              console.warn('[scheduler] 系统通知失败', e);
            }
          }
        },
      );
    })();
    return () => unlisten?.();
  }, []);

  return null;
}

/** 判断当前是否在勿扰时段。 */
function isInDndWindow(): boolean {
  try {
    const raw = localStorage.getItem(DND_STORAGE);
    if (!raw) return false;
    const m = raw.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const [, sh, sm, eh, em] = m;
    const start = Number(sh) * 60 + Number(sm);
    const end = Number(eh) * 60 + Number(em);
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    // 跨夜（如 23:00-07:00）：cur >= start 或 cur < end。
    if (start <= end) return cur >= start && cur < end;
    return cur >= start || cur < end;
  } catch {
    return false;
  }
}

/** 调 tauri-plugin-notification 发系统通知。 */
async function sendSystemNotification(title: string, body: string): Promise<void> {
  const tauri = (window as unknown as {
    __TAURI__?: { notification?: { sendNotification?: (n: unknown) => void } };
  }).__TAURI__;
  tauri?.notification?.sendNotification?.({ title, body });
}
