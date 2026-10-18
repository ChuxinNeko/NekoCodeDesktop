/**
 * Wallpaper Engine's web API shim lives as a template literal inside
 * `webwallgl.mjs` (`const shimSource = \`...\``). Web wallpaper HTML has to
 * carry it: the renderer's sandbox cannot reach into that frame to install
 * the API afterwards.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(__filename);

let engineDirCache: string | null | undefined;
let shimCache: string | undefined;

export function wallpaperEngineDir(): string | null {
	if (engineDirCache !== undefined) return engineDirCache;
	try {
		engineDirCache = dirname(require.resolve("webwallgl/package.json"));
	} catch {
		engineDirCache = null;
	}
	return engineDirCache;
}

function cookTemplateLiteral(raw: string): string {
	const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
	return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_match, token: string) => {
		if (token.startsWith("u") && token.length > 1) {
			const hex = token[1] === "{" ? token.slice(2, -1) : token.slice(1);
			return String.fromCodePoint(Number.parseInt(hex, 16));
		}
		if (token.startsWith("x") && token.length === 3) return String.fromCharCode(Number.parseInt(token.slice(1), 16));
		if (token === "\n" || token === "\r\n" || token === "\r") return "";
		return token in simple ? (simple[token] ?? token) : token;
	});
}

export function readWebShim(): string {
	if (shimCache !== undefined) return shimCache;
	const dir = wallpaperEngineDir();
	if (!dir) {
		shimCache = "";
		return shimCache;
	}
	try {
		const bundle = readFileSync(join(dir, "webwallgl.mjs"), "utf8");
		const match = /const shimSource = `([\s\S]*?)`;/.exec(bundle);
		const body = match?.[1];
		shimCache = body && !/(^|[^\\])\$\{/.test(body) ? cookTemplateLiteral(body) : "";
	} catch {
		shimCache = "";
	}
	return shimCache;
}
