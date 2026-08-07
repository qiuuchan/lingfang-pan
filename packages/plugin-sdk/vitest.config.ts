import { defineConfig } from 'vitest/config';

// 仅运行受版本控制的测试文件（*.spec.ts）。显式排除 *-tdd-* 临时/红态用例，
// 使其不进入 CI 门禁。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.mjs', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*-tdd-*'],
  },
});
