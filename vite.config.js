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
    open: true,
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
});
