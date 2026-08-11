import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import App from './App';
import { ErrorBoundary, initSentry, installGlobalHandlers } from './monitoring';
import './index.css';

// P3-1/P3-2：最早期初始化错误上报（DSN 缺失时 console 兜底，不崩溃）。
initSentry();
installGlobalHandlers();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <Toaster richColors closeButton position="top-right" />
  </React.StrictMode>
);
