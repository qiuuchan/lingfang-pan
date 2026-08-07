import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 插件中心使用同源 /api/web/* 设计，dev 时需把 /api 代理到 collab-api。
// 默认指向后端默认端口 19006；可用 VITE_API_PROXY_TARGET 覆盖（多后端/不同端口场景）。
// 注：web dev 端口用 19007，避免与后端 collab-api 默认 19006 冲突。
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:19006';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 19007,
    proxy: { '/api': { target: apiProxyTarget, changeOrigin: true } },
  },
  test: { include: ['src/**/*.spec.ts'] },
});
