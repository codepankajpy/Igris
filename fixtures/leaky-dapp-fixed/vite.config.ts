import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Keep identifiers readable so scan snippets and diffs are legible.
    minify: false,
  },
});
