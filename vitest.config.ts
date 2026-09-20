import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Transform the ESM SDK so unit fixtures can replace Electron's native API.
    server: { deps: { inline: ['@workos/authkit-electron'] } },
  },
});
