// 从 'vitest/config' 而不是 'vite' 导入 defineConfig：本文件带 test 段，
// 用 vite 的 defineConfig 时 test 是个未知属性，写错 key 也不会有类型报错，
// 只会静默失效（配置不生效但测试照跑，看不出来）。
import { defineConfig } from 'vitest/config';
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
  // include 与其它工作区包统一，避免在本包按 *.test.ts 命名时被静默跳过。
  test: { include: ['src/**/*.{test,spec}.{ts,tsx,mts,mjs}'] },
});
