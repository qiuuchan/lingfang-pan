// playwright.config.ts — 桌面端 UI 自动化测试配置。
//
// 用系统已装的 Chrome（channel: 'chrome'），不下载 Playwright 自带 Chromium。
// webServer 自动起 vite dev（纯 web 模式，不走 Tauri），测试在 localhost:1420 跑。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // 单页应用，串行跑避免状态干扰
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // 用系统 Chrome（避免下载 Chromium）
    channel: 'chrome',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm vite --port 1420',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
