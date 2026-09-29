import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8000' },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        studio: resolve(root, 'studio.html'),
      },
    },
  },
});
