import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle workspace packages (TypeScript source) into the output; keep real node_modules external.
  noExternal: [/^@tempo\//],
  external: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  banner: { js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);' },
});
