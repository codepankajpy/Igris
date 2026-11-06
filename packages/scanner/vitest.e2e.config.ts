import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One file at a time: tests share fixed local ports (38545/38546).
    fileParallelism: false,
    pool: 'forks',
  },
});
