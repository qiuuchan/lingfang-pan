import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

function assetBase(): string {
  const raw = process.env.VITE_CDN_BASE_URL || process.env.VITE_ASSET_BASE_URL || '';
  if (!raw.trim()) return '/';
  return raw.trim().replace(/\/?$/, '/');
}

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
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: { manualChunks },
    },
  },
});
