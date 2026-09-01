import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the production build works from any sub-path
  // (and can even be opened directly from the file system).
  base: './',
  server: {
    // Pinned to 5001 (next to the bridge on 5000). 3000 belongs to
    // IntelliTrade's frontend; strictPort fails loudly instead of drifting.
    port: 5001,
    strictPort: true,
    // The Windows launcher opens the browser after the app is ready. Keeping
    // this disabled prevents Vite and start-alphaedge.bat from opening two
    // AlphaEdge homepages during startup.
    open: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  // Engine unit tests only — never crawl the vendored build_assets snapshot.
  test: {
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
});
