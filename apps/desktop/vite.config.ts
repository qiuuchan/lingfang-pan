import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Tauri 前端构建：开发起 1420 端口（tauri.conf.json devUrl 对应），产物输出 dist（frontendDist=../dist）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port: 1420, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
