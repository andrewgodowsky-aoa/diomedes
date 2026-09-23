import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
import path from 'node:path';
// The packaged renderer talks only to its own loopback service. Keep the
// development page free of this policy so Vite's HMR transport still works.
const desktopContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'none'",
].join('; ');

// A worktree may reach node_modules through a junction; the dev server must be allowed to serve the
// real location or the bundled fonts come back 403 in development only.
const modules = (() => {
  try {
    return realpathSync(path.resolve('node_modules'));
  } catch {
    return path.resolve('node_modules');
  }
})();
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(command === 'build' ? [{
      name: 'diomedes-desktop-csp',
      transformIndexHtml: {
        order: 'post' as const,
        handler: () => [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: desktopContentSecurityPolicy,
          },
          injectTo: 'head-prepend' as const,
        }],
      },
    }] : []),
  ],
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
}));
