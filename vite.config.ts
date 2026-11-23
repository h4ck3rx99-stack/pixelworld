import { defineConfig } from 'vite';

export default defineConfig({
  server: { proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } } },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
