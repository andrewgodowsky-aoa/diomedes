import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { appContentSecurityPolicy } from './scripts/app-csp';
// A worktree may reach node_modules through a junction; the dev server must be allowed to serve the
// real location or the bundled fonts come back 403 in development only.
const modules = (() => {
  try {
    return realpathSync(path.resolve('node_modules'));
  } catch {
    return path.resolve('node_modules');
  }
})();
export default defineConfig({
  // The built index.html carries the app's Content-Security-Policy (scripts/app-csp.ts).
  plugins: [react(), appContentSecurityPolicy()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DIOMEDES_CLIENT_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.DIOMEDES_PORT ?? 47631}` },
    fs: { allow: [path.resolve('.'), modules] },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { app: path.resolve('index.html'), inventory: path.resolve('inventory.html') },
    },
  },
});
