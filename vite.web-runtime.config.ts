import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/web-runtime/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "vega-cubism-web-runtime.mjs",
    },
    outDir: "dist/web-runtime",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    sourcemap: false,
    target: "es2022",
  },
});
