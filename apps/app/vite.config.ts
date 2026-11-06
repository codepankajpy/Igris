import { defineConfig } from 'vite';

// Preact JSX via the automatic runtime (tsconfig: jsx react-jsx,
// jsxImportSource preact) — no Babel preset needed.
export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  preview: { port: 5180, proxy: { '/api': { target: 'http://127.0.0.1:3001' } } },
});
