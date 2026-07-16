import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
  testDir: '.',
  testMatch: 'client.spec.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: join(tmpdir(), 'lingfang-action-adapter-conformance'),
  use: {
    baseURL: 'http://127.0.0.1:1421',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm vite --host 127.0.0.1 --port 1421',
    url: 'http://127.0.0.1:1421/action-adapter-conformance/harness.html',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
