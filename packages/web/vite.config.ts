import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  // @karyakram/core is a pnpm workspace symlink, not a real node_modules
  // package — Vite skips its usual CJS->ESM pre-bundling for linked
  // packages (it assumes those are source to watch, not deps to bundle).
  // But core compiles to CommonJS (matching every other Node consumer in
  // this repo), so without forcing it through the pre-bundler, the
  // browser tries to load its compiled dist/index.js as native ESM and
  // fails to find named exports like `foldEvents`. See docs/05-control-plane.md.
  optimizeDeps: {
    include: ['@karyakram/core'],
  },
});
