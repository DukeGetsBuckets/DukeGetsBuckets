import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ configPath: './wrangler.jsonc' })],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@game': path.resolve(__dirname, 'src/game'),
      '@ui': path.resolve(__dirname, 'src/ui'),
      '@app': path.resolve(__dirname, 'src/app'),
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', 'postprocessing'],
          rapier: ['@dimforge/rapier3d-compat'],
          react: ['react', 'react-dom', 'zustand'],
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
