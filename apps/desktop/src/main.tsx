import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import App from '@/App';
import { initApiBase, initAuthToken, tauriInvoke } from '@/lib/api';
import { initSentry, installGlobalHandlers, reportError } from '@/monitoring';
import '@/index.css';

// P3-1/P3-2：最早期初始化错误上报（DSN 缺失时 console 兜底，不崩溃）。
initSentry();
installGlobalHandlers();

// DESK-SHELL-05 修复：渲染树顶层 ErrorBoundary。
// 此前任何 render 阶段抛错（如 sessionFromPayload 对畸形 /api/auth/me 响应裸解引用）
// 会让 React 卸载整棵树 → 白屏不可恢复，Tauri 用户只能强杀进程重启。
// 此 ErrorBoundary 兜底渲染降级 UI，并提供「重置本地会话」按钮让用户自救（清掉损坏的 lf:session）。
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // 控制台留痕便于排障（不外发），与「不写 .md 报告」一致。
    // eslint-disable-next-line no-console
    console.error('应用渲染崩溃：', error, info?.componentStack);
    // P3-2：render 阶段崩溃同时上报（DSN 缺失时 console 兜底，不静默）。
    reportError(error, { phase: 'react', componentStack: info?.componentStack ?? '' });
  }

  handleReset = () => {
    // P1-1 修复：此前只 reload——内存态虽清，但 Rust 侧 session.json 的持久令牌副本
    // 仍在，下次启动 restoreTokenFromHost 会原样拉回，等于没重置。
    // 先显式把 Rust 副本清成 null，成功后再重载（失败也重载：非桌面环境静默降级）。
    void (async () => {
      try {
        await tauriInvoke<null>('persist_auth_token', { token: null });
      } catch {
        /* 网页预览 / 旧壳无命令：忽略 */
      }
      window.location.reload();
    })();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            minHeight: '100vh',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0b0e14',
            color: '#e2e8f0',
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 480,
              textAlign: 'center',
              fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            }}
          >
            <h1 style={{ fontSize: 20, marginBottom: 8 }}>应用遇到错误</h1>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16 }}>
              页面渲染过程中出现问题。可以重置本地会话后重新进入应用。
            </p>
            <pre
              style={{
                textAlign: 'left',
                background: '#0f172a',
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                overflow: 'auto',
                maxHeight: 200,
                marginBottom: 16,
              }}
            >
              {this.state.error.message || String(this.state.error)}
            </pre>
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                padding: '8px 16px',
                background: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              重置本地会话并重载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

async function bootstrap() {
  let defaultApiBase: string | null = null;
  try {
    // DESK-SHELL-02 修复：app.config.json fetch 加 5s 超时（AbortController），
    // 避免该 fetch 挂起导致 bootstrap 永不 render、整屏白屏。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch('app.config.json', { cache: 'no-store', signal: controller.signal });
      const cfg = (await res.json()) as { api_base?: string };
      defaultApiBase = cfg.api_base ?? null;
    } catch {
      /* 无打包默认配置则进入后端地址配置入口；超时也走 fallback */
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* 无打包默认配置则进入后端地址配置入口 */
  }
  initApiBase(defaultApiBase);
  initAuthToken();
  // Task 10 修复：移除 React.StrictMode。
  // StrictMode 在 dev 下对每个组件执行 mount→unmount→remount，导致 framer-motion 的入场动画
  // （StaggerContainer/FadeIn/PageTransition）每次挂载都重播——点击插件触发列表/运行器重挂载时，
  // 用户可见「展示动画重复播放两次」。生产构建（.exe）StrictMode 本就是 no-op，移除后 dev 行为与
  // 生产一致。StrictMode 的收益（暴露 effect 清理缺陷）本仓库已在各 effect 内以注释 + ref 兜底覆盖。
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </ThemeProvider>
  );
}

bootstrap();
