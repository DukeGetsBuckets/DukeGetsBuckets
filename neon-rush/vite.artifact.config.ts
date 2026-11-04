// Static single-player build used for the shareable prototype page (no Worker backend).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  define: { 'import.meta.env.VITE_STATIC_DEMO': JSON.stringify('1') },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@game': path.resolve(__dirname, 'src/game'),
      '@ui': path.resolve(__dirname, 'src/ui'),
      '@app': path.resolve(__dirname, 'src/app'),
    },
  },
  build: { target: 'es2022', outDir: 'dist-artifact', emptyOutDir: true, chunkSizeWarningLimit: 6000, modulePreload: false },
});
