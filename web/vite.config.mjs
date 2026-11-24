import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: "./",
  define: { global: "globalThis" },
  resolve: { alias: { buffer: "buffer/" } },
  optimizeDeps: { include: ["buffer"] },
  build: { outDir: resolve(root, "dist"), emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
