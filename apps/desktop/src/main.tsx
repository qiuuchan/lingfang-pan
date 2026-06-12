import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import App from '@/App';
import { initApiBase } from '@/lib/api';
import '@/index.css';

async function bootstrap() {
  let defaultApiBase: string | null = null;
  try {
    const res = await fetch('app.config.json', { cache: 'no-store' });
    const cfg = (await res.json()) as { api_base?: string };
    defaultApiBase = cfg.api_base ?? null;
  } catch {
    /* 无打包默认配置则进入后端地址配置入口 */
  }
  initApiBase(defaultApiBase);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
}

bootstrap();
