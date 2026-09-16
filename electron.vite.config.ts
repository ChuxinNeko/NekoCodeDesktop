import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const rendererSrc = resolve("src/renderer/src");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
