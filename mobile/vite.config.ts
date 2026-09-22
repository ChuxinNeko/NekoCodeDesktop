import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
	root: resolve("mobile"),
	publicDir: resolve("src/renderer/public"),
	base: "./",
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": resolve("src/renderer/src"), "~": resolve("src/renderer/src") } },
	build: { outDir: resolve("out/mobile"), emptyOutDir: true },
	server: {
		host: "127.0.0.1", port: 5174, strictPort: true,
		proxy: {
			"/desktop": {
				target: process.env.NEKOCODE_TEST_LAN_URL ?? "http://127.0.0.1:47834", changeOrigin: true,
				rewrite: (path) => path.replace(/^\/desktop/, ""),
				configure: (proxy) => { proxy.on("proxyReq", (req) => req.removeHeader("origin")); },
			},
			// Browser-only. On a device the account client uses CapacitorHttp, which
			// is not subject to CORS; in dev this stands in for that, so the public
			// backend needs no CORS headers of its own.
			"/account": {
				target: process.env.NEKOCODE_ACCOUNT_URL ?? "https://codeapi.nekofun.top", changeOrigin: true,
				rewrite: (path) => path.replace(/^\/account/, ""),
			},
			"/relay": {
				target: process.env.NEKOCODE_ACCOUNT_URL ?? "https://codeapi.nekofun.top", changeOrigin: true, ws: true,
			},
		},
	},
});
