import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App';
import { setApiBase } from '@/lib/api';
import '@/index.css';

// 启动前加载分发配置（后端地址），失败则用默认值，不阻断应用渲染。
async function bootstrap() {
  try {
    const res = await fetch('app.config.json', { cache: 'no-store' });
    const cfg = (await res.json()) as { api_base?: string };
    setApiBase(cfg.api_base);
  } catch {
    /* 无配置文件则用默认后端地址 */
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

bootstrap();
