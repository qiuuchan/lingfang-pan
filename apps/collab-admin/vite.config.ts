import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';

function assetBase(): string {
  const raw = process.env.VITE_CDN_BASE_URL || process.env.VITE_ASSET_BASE_URL || '';
  if (!raw.trim()) return '/';
  return raw.trim().replace(/\/?$/, '/');
}

// 构建时注入 git commit hash + 提交时间，供页脚展示「最后提交版本号」。
// 每次构建自动取当前 HEAD（git rev-parse --short HEAD），无需手动维护。
// 失败（非 git 仓库/无 git）兜底 'unknown'，不阻断构建。
function gitCommitInfo(): { hash: string; date: string } {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    const date = execSync('git show -s --format=%ci HEAD', { encoding: 'utf-8' }).trim();
    return { hash, date };
  } catch {
    return { hash: 'unknown', date: '' };
  }
}

const gitInfo = gitCommitInfo();

function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
  if (id.includes('@radix-ui')) return 'ui-vendor';
  if (id.includes('framer-motion') || id.includes('/motion-dom') || id.includes('/motion-utils')) return 'motion-vendor';
  if (id.includes('lucide-react')) return 'icons-vendor';
  if (id.includes('sonner')) return 'toast-vendor';
  return undefined;
}

export default defineConfig({
  base: assetBase(),
  plugins: [react(), tailwindcss()],
  define: {
    // 注入 git commit 信息（页脚展示最后提交版本号，每次 build 自动更新）。
    __GIT_COMMIT__: JSON.stringify(gitInfo.hash),
    __GIT_DATE__: JSON.stringify(gitInfo.date),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 650,
    // 生产构建不产出 sourcemap，避免源码经 .map 公开暴露（审计 L4）。
    sourcemap: false,
    rollupOptions: {
      output: { manualChunks },
    },
  },
});
