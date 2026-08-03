import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const runtimeBridgePath = fileURLToPath(
  new URL("./src/web-runtime/runtime-bridge.ts", import.meta.url),
);

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(
        new URL("./src/web-runtime/viewer-entry.ts", import.meta.url),
      ),
      formats: ["es"],
      fileName: () => "vega-cubism-web-viewer.mjs",
    },
    outDir: "dist/web-runtime",
    rollupOptions: {
      external: (id, _importer, isResolved) =>
        Boolean(isResolved && id === runtimeBridgePath),
      output: {
        inlineDynamicImports: true,
        paths: (id) =>
          id === runtimeBridgePath
            ? "./vega-cubism-web-runtime.mjs"
            : id,
      },
    },
    sourcemap: false,
    target: "es2022",
  },
});
