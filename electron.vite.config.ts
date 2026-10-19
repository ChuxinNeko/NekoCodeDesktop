import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { cpSync } from "node:fs";
import type { Plugin } from "vite";

const rendererSrc = resolve("src/renderer/src");

/**
 * Monaco's language modes carry a fallback, `new Worker(new URL("ts.worker.js",
 * import.meta.url))`, which Vite answers by emitting every language worker as a
 * separate file (~16 MB). The fallback only runs when MonacoEnvironment has no
 * `getWorker` (monaco-editor/esm/vs/internal/common/workers.js), and ours always
 * has one — monaco-setup.ts starts the inlined workers instead — so the emitted
 * copies were dead weight in the package.
 */
function dropMonacoWorkerFallbacks(): Plugin {
  return {
    name: "nekocode:drop-monaco-worker-fallbacks",
    enforce: "pre",
    transform(code, id) {
      if (!/monaco-editor[\\/]esm[\\/]vs[\\/]languages[\\/]features[\\/][^\\/]+[\\/]workerManager\.js$/.test(id)) {
        return null;
      }
      const next = code.replace(
        /createWorker:\s*\(\)\s*=>\s*new Worker\(new URL\([^)]*\),\s*\{[^}]*\}\)/g,
        "createWorker: undefined",
      );
      if (next === code) {
        throw new Error(`Monaco worker fallback not found in ${id}; update dropMonacoWorkerFallbacks.`);
      }
      return { code: next, map: null };
    },
  };
}

export default defineConfig({
  main: {
    // Bundle imported native icons into out/main instead of leaving paths to resources/.
    publicDir: "resources/public",
    plugins: [externalizeDepsPlugin(), {
      name: "nekocode:sandbox-assets",
      writeBundle() {
        cpSync(resolve("server/sandbox"), resolve("out/main/sandbox"), { recursive: true });
      },
    }],
    build: {
      // Lib mode with a second entry, rather than rollupOptions.input: an explicit
      // input turns off the lib build this config relies on (single CommonJS
      // index.js, dependencies left to node_modules).
      lib: {
        entry: {
          index: resolve("src/main/index.ts"),
          // Computer Use runs the native desktop driver in its own utility process.
          "computer-worker": resolve("src/main/computer/worker.ts"),
          "session-list-worker": resolve("src/main/session-list-worker.ts"),
        },
        formats: ["cjs"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss(), dropMonacoWorkerFallbacks()],
    build: {
      // electron-vite leaves every target unminified. Main and preload stay that
      // way (readable stack traces, little to gain), but the renderer carries
      // Monaco and its inlined language workers, which minify to about half.
      minify: true,
    },
    resolve: {
      alias: {
        "@": rendererSrc,
        // Synara components use the "~/" alias; keep it so ported files stay verbatim.
        "~": rendererSrc,
      },
    },
  },
});
