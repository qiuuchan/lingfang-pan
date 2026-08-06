import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// 管理前端单元测试基座。
// - environment: jsdom —— 被测模块（@/lib/api 等）顶层会读 localStorage / window，
//   纯 node 环境会因缺少浏览器全局而崩溃；jsdom 提供 localStorage/window/document。
// - alias '@' 与 vite.config.ts 保持一致，保证源码 `@/lib/...` 导入在测试里可解析。
// - globals: true —— 可用 describe/it/expect 全局，无需每文件 import。
// 仅覆盖 `*.test.ts` 纯函数单测；组件/e2e 由 playwright（test:e2e）负责。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
    // 前端纯函数单测不依赖真实后端/数据库，无需外部服务即可全绿。
    // 若后续引入需要服务的集成测试，按 backend 惯例用 env 门控 describe.skip。
  },
});
