import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    manifest: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      // These directives are meaningful to RSC frameworks, not this static app.
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
      output: {
        manualChunks: {
          "react-runtime": ["react", "react-dom/client"],
          motion: ["motion/react"],
        },
      },
      input: {
        home: fileURLToPath(new URL("./index.html", import.meta.url)),
        docs: fileURLToPath(new URL("./docs.html", import.meta.url)),
        build: fileURLToPath(new URL("./build.html", import.meta.url)),
        benchmarks: fileURLToPath(
          new URL("./benchmarks.html", import.meta.url),
        ),
      },
    },
  },
});
