import { defineConfig } from 'vitest/config';

// collab-api 单测配置：node 环境 + 仅采集 src 下的 *.spec.ts。
// 关键：用 include 白名单锁定 src，避免 tsc build 产物（dist/**/*.spec.js，CommonJS）
// 被 vitest 默认扫描到（require('vitest') 在 CJS 下失败，导致测试文件误报 fail）。
// 对齐桌面端 apps/desktop/vitest.config.ts 的白名单模式。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx,mts,mjs}'],
  },
});
