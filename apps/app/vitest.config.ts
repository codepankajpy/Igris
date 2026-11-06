import { defineConfig } from 'vitest/config';

// Unit tests of the app's pure modules (routing, display wording, styles).
// The browser e2e suite has its own config (vitest.e2e.config.ts).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
