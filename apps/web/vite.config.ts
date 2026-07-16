import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { port: 19006 }, test: { include: ['src/**/*.spec.ts'] } });
