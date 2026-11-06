import { defineConfig } from 'vitest/config';

// Browser e2e for the built web app (same pattern as packages/scanner).
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
    // Always print the per-route request summary (the proof), not only on failure.
    silent: false,
  },
});
