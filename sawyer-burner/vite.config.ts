import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    sourcemap: false,
    // Never inline fonts as data: URIs — the CSP only allows font-src 'self'.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
    chunkSizeWarningLimit: 600,
  },
});
