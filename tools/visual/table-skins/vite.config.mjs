import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  root: process.cwd(),
  publicDir: 'apps/web/public',
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5193, strictPort: true },
});
