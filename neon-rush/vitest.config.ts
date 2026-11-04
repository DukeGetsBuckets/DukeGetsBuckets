import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@game': path.resolve(__dirname, 'src/game'),
      '@ui': path.resolve(__dirname, 'src/ui'),
      '@app': path.resolve(__dirname, 'src/app'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
  },
});
