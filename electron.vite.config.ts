import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const rendererSrc = resolve("src/renderer/src");

export default defineConfig({
  main: {
    // Bundle imported native icons into out/main instead of leaving paths to resources/.
    publicDir: "resources/public",
    plugins: [externalizeDepsPlugin()],
    build: {
      // Lib mode with a second entry, rather than rollupOptions.input: an explicit
      // input turns off the lib build this config relies on (single CommonJS
      // index.js, dependencies left to node_modules).
      lib: {
        entry: {
          index: resolve("src/main/index.ts"),
          // Computer Use runs the native desktop driver in its own utility process.
          "computer-worker": resolve("src/main/computer/worker.ts"),
        },
        formats: ["cjs"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": rendererSrc,
        // Synara components use the "~/" alias; keep it so ported files stay verbatim.
        "~": rendererSrc,
      },
    },
  },
});
