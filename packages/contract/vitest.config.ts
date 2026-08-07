import { defineConfig } from 'vitest/config';

// 仅运行受版本控制的测试文件（*.test.mjs / *.spec.ts / *.test.ts）。
// 显式排除 *-tdd-* 文件：那些是探索期/红态（red-state）的临时用例，
// 不入库、不进入 CI 门禁，避免未完成的特性测试把门禁弄红。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.mjs', 'src/**/*.spec.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*-tdd-*'],
  },
});
