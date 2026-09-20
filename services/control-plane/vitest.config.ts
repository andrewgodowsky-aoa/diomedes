import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/support/no-network.ts'],
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
