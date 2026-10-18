/**
 * Local wallpaper host.
 *
 * Discovery and the project scan follow the Wallpaper Engine host this was
 * taken from. Scene and web wallpapers are handed to WebWallGL through the
 * same live page: the page's `httpSource` reads `project.json` and `scene.pkg`
 * from the project directory, and web documents get the WE API shim injected
 * before any author script. Video wallpapers are the project file itself.
 * Custom images live under the app's user-data directory.
 *
 * Bytes are served on a privileged `nekowallpaper://` scheme so the sandboxed
 * window can show them without opening the page to the rest of the network.
 */
import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	WallpaperChooseResult,
	WallpaperEntry,
	WallpaperLibrary,
	WallpaperOrigin,
	WallpaperPlay,
	WallpaperPlayRequest,
	WallpaperUpload,
} from "../../shared/wallpaper";
import { locateWallpaperEngine, owningLibraries } from "./discover";
import { enumerateWallpapers, type ScannedWallpaper } from "./scan";
import { readWebShim, wallpaperEngineDir } from "./shim";
import { buildSeedScript } from "./we-props";
import liveHtml from "./live/index.html?raw";
import liveRenderer from "./live/renderer.js?raw";
import liveFallback from "./live/fallback.html?raw";

const SCHEME = "nekowallpaper";
const HOST = "local";
const LIBRARY_TTL_MS = 60_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_UPLOADS = 24;

try {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: SCHEME,
			privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
		},
	]);
} catch {
	// A dev reload can evaluate this module again after the scheme is already privileged.
}

interface UploadRecord {
	id: string;
	name: string;
	ext: string;
}

interface LibraryCache {
	at: number;
	installed: boolean;
	installDir: string | null;
	entries: Map<string, ScannedWallpaper>;
}

let userDataDir = "";
let token = "";
let handled = false;
let libraryCache: LibraryCache | null = null;
let libraryInflight: Promise<LibraryCache> | null = null;

function baseUrl(): string {
	return `${SCHEME}://${HOST}/${token}`;
}

function cors(extra?: Record<string, string>): Headers {
	const headers = new Headers(extra);
	headers.set("access-control-allow-origin", "*");
	headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
	headers.set("access-control-allow-headers", "*");
	headers.set("access-control-expose-headers", "Accept-Ranges, Content-Length, Content-Range, ETag");
	return headers;
}

function text(status: number, body: string): Response {
	return new Response(body, { status, headers: cors({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }) });
}

function contentType(file: string): string {
	switch (extname(file).slice(1).toLowerCase()) {
		case "html":
		case "htm":
			return "text/html; charset=utf-8";
		case "js":
		case "mjs":
			return "text/javascript; charset=utf-8";
		case "css":
			return "text/css; charset=utf-8";
		case "json":
			return "application/json; charset=utf-8";
		case "svg":
			return "image/svg+xml";
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "bmp":
			return "image/bmp";
		case "mp4":
			return "video/mp4";
		case "webm":
			return "video/webm";
		case "ogg":
		case "ogv":
			return "video/ogg";
		case "mp3":
			return "audio/mpeg";
		case "wav":
			return "audio/wav";
		case "wasm":
			return "application/wasm";
		default:
			return "application/octet-stream";
	}
}

function safeId(raw: string): string | null {
	let id: string;
	try {
		id = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (!id || id.length > 180 || id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) return null;
	return id;
}

function safeRelative(parts: string[]): string | null {
	if (parts.length === 0) return null;
	const decoded: string[] = [];
	for (const part of parts) {
		const id = safeId(part);
		if (!id) return null;
		decoded.push(id);
	}
	return decoded.join(sep);
}

/** `ok` only when `target` is a real file inside `root`. Symlinks are refused. */
function locateFile(root: string, target: string): "ok" | "missing" | "denied" {
	if (!existsSync(target)) return "missing";
	let rootReal = "";
	let targetReal = "";
	try {
		if (lstatSync(target).isSymbolicLink()) return "denied";
		rootReal = realpathSync(root);
		targetReal = realpathSync(target);
	} catch {
		return "denied";
	}
	const rel = relative(rootReal, targetReal);
	if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return "denied";
	try {
		if (!lstatSync(targetReal).isFile()) return "missing";
	} catch {
		return "missing";
	}
	return "ok";
}

function fileResponse(request: Request, abs: string, cacheControl: string): Response {
	const info = lstatSync(abs);
	const total = info.size;
	const etag = `W/"${info.size}-${Math.round(info.mtimeMs)}"`;
	if (total === 0) {
		const empty = cors({
			"accept-ranges": "bytes",
			etag,
			"cache-control": cacheControl,
			"content-type": contentType(abs),
			"content-length": "0",
		});
		return new Response(null, { status: 200, headers: empty });
	}
	const headers = cors({
		"accept-ranges": "bytes",
		etag,
		"cache-control": cacheControl,
		"content-type": contentType(abs),
	});
	const ranged = request.headers.get("range");
	if (!ranged && request.headers.get("if-none-match") === etag) {
		return new Response(null, { status: 304, headers });
	}
	let start = 0;
	let end = total - 1;
	let status = 200;
	if (ranged) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(ranged);
		if (!match || total === 0) {
			headers.set("content-range", `bytes */${total}`);
			return new Response(null, { status: 416, headers });
		}
		if (!match[1] && match[2]) {
			const suffix = Number(match[2]);
			start = Math.max(0, total - suffix);
		} else {
			start = match[1] ? Number(match[1]) : 0;
			end = match[2] ? Number(match[2]) : total - 1;
		}
		if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
			headers.set("content-range", `bytes */${total}`);
			return new Response(null, { status: 416, headers });
		}
		end = Math.min(end, total - 1);
		status = 206;
		headers.set("content-range", `bytes ${start}-${end}/${total}`);
	}
	const length = end - start + 1;
	headers.set("content-length", String(Math.max(0, length)));
	if (request.method === "HEAD") return new Response(null, { status, headers });
	const stream = createReadStream(abs, { start, end });
	request.signal.addEventListener("abort", () => stream.destroy());
	return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
}

function uploadDir(): string {
	return join(userDataDir, "wallpapers");
}

function uploadMetaPath(): string {
	return join(uploadDir(), "uploads.json");
}

function uploadPath(record: UploadRecord): string {
	return join(uploadDir(), "files", `${record.id}.${record.ext}`);
}

async function readUploads(): Promise<UploadRecord[]> {
	try {
		const parsed = JSON.parse(await readFile(uploadMetaPath(), "utf8")) as { items?: unknown };
		if (!Array.isArray(parsed.items)) return [];
		return parsed.items.filter((item): item is UploadRecord => {
			if (!item || typeof item !== "object") return false;
			const record = item as UploadRecord;
			return typeof record.id === "string" && typeof record.name === "string" && typeof record.ext === "string";
		});
	} catch {
		return [];
	}
}

async function writeUploads(items: UploadRecord[]): Promise<void> {
	await mkdir(uploadDir(), { recursive: true });
	const dest = uploadMetaPath();
	const tmp = `${dest}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify({ items }));
	await rename(tmp, dest);
}

function publish(entry: ScannedWallpaper): WallpaperEntry {
	return {
		id: entry.id,
		title: entry.title,
		type: entry.type,
		contentrating: entry.contentrating,
		schemeColor: entry.schemeColor,
		hasPreview: Boolean(entry.previewAbs),
		mediaExt: entry.mediaExt,
	};
}

async function loadLibrary(): Promise<LibraryCache> {
	const installDir = await locateWallpaperEngine();
	const libraries = await owningLibraries();
	const scanned = await enumerateWallpapers(installDir, libraries);
	const entries = new Map<string, ScannedWallpaper>();
	for (const entry of scanned) entries.set(entry.id, entry);
	return {
		at: Date.now(),
		installed: Boolean(installDir) || entries.size > 0,
		installDir,
		entries,
	};
}

async function ensureLibrary(force: boolean): Promise<LibraryCache> {
	if (!force && libraryCache && Date.now() - libraryCache.at < LIBRARY_TTL_MS) return libraryCache;
	if (!force && libraryInflight) return libraryInflight;
	const run = loadLibrary().then((cache) => {
		libraryCache = cache;
		return cache;
	});
	libraryInflight = run;
	try {
		return await run;
	} finally {
		if (libraryInflight === run) libraryInflight = null;
	}
}

function imageExtension(bytes: Buffer): string | null {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (bytes.length >= 6) {
		const magic = bytes.toString("ascii", 0, 6);
		if (magic === "GIF87a" || magic === "GIF89a") return "gif";
	}
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
	return null;
}

function displayName(file: string): string {
	const name = basename(file, extname(file)).trim();
	return (name || "Image").slice(0, 80);
}

async function chooseImage(window: BrowserWindow): Promise<WallpaperChooseResult> {
	const picked = await dialog.showOpenDialog(window, {
		title: "选择壁纸图片",
		properties: ["openFile"],
		filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
	});
	if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: "canceled" };
	const source = picked.filePaths[0];
	try {
		const info = await stat(source);
		if (!info.isFile()) return { ok: false, error: "unsupported" };
		if (info.size > MAX_IMAGE_BYTES) return { ok: false, error: "too-large" };
		const handle = await open(source, "r");
		const header = Buffer.alloc(16);
		try {
			await handle.read(header, 0, 16, 0);
		} finally {
			await handle.close();
		}
		const ext = imageExtension(header);
		if (!ext) return { ok: false, error: "unsupported" };
		const existing = await readUploads();
		if (existing.length >= MAX_UPLOADS) return { ok: false, error: "limit" };
		const record: UploadRecord = { id: `img_${randomBytes(8).toString("hex")}`, name: displayName(source), ext };
		const dest = uploadPath(record);
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(source, dest);
		await writeUploads([...existing, record]);
		return { ok: true, upload: { id: record.id, name: record.name } };
	} catch (error) {
		console.error("wallpaper upload:", error);
		return { ok: false, error: "failed" };
	}
}

function readProject(dir: string): unknown {
	try {
		return JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as unknown;
	} catch {
		return null;
	}
}

function injectWebHtml(html: string, entry: ScannedWallpaper, file: string): string {
	if (html.includes("data-we-shim")) return html;
	const projectDir = existsSync(join(dirname(file), "project.json")) ? dirname(file) : entry.dirAbs;
	const project = readProject(projectDir);
	const rel = relative(projectDir, file).replace(/\\/g, "/");
	const seed = buildSeedScript(project, rel);
	const shim = readWebShim();
	const escapeScript = (source: string) => source.replace(/<\/script/gi, "<\\/script");
	const siteRoot = `/${token}/files/${encodeURIComponent(entry.id)}/`;
	const tag =
		`<script data-we-site-root="host">window.__weSiteRoot=${JSON.stringify(siteRoot)};</script>` +
		(shim ? `<script data-we-shim="host">${escapeScript(shim)}</script>` : "") +
		(seed ? `<script data-we-seed="host">${escapeScript(seed)}</script>` : "");
	const head = /<head[^>]*>/i.exec(html);
	if (!head) return tag + html;
	const at = head.index + head[0].length;
	return html.slice(0, at) + tag + html.slice(at);
}

function staticPage(body: string, type: string): Response {
	return new Response(body, {
		status: 200,
		headers: cors({ "content-type": type, "cache-control": "no-store" }),
	});
}

async function handleRequest(request: Request): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
	if (request.method !== "GET" && request.method !== "HEAD") return text(405, "method");
	const url = new URL(request.url);
	if (url.hostname !== HOST) return text(404, "not found");
	if (url.pathname === "/diag") return new Response(null, { status: 204, headers: cors({ "cache-control": "no-store" }) });
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] !== token) return text(404, "not found");
	const kind = parts[1];
	if (kind === "live") {
		const page = parts.slice(2).join("/");
		if (page === "index.html") return staticPage(liveHtml, "text/html; charset=utf-8");
		if (page === "renderer.js") return staticPage(liveRenderer, "text/javascript; charset=utf-8");
		if (page === "default-wallpaper/index.html") return staticPage(liveFallback, "text/html; charset=utf-8");
		if (parts[2] === "engine") {
			const engine = wallpaperEngineDir();
			const rel = safeRelative(parts.slice(3));
			if (!engine || !rel) return text(404, "not found");
			const abs = resolve(engine, rel);
			const found = locateFile(engine, abs);
			if (found !== "ok") return text(found === "denied" ? 403 : 404, found);
			return fileResponse(request, abs, "public, max-age=86400");
		}
		return text(404, "not found");
	}

	const id = parts[2] ? safeId(parts[2]) : null;
	if (!id || (kind !== "preview" && kind !== "upload" && kind !== "media" && kind !== "files")) return text(404, "not found");

	if (kind === "upload") {
		const record = (await readUploads()).find((item) => item.id === id);
		if (!record) return text(404, "not found");
		const abs = uploadPath(record);
		const found = locateFile(join(uploadDir(), "files"), abs);
		if (found !== "ok") return text(found === "denied" ? 403 : 404, found);
		return fileResponse(request, abs, "public, max-age=86400");
	}

	const library = libraryCache ?? (await ensureLibrary(false));
	const entry = library.entries.get(id);
	if (!entry) return text(404, "not found");

	if (kind === "preview" || kind === "media") {
		const abs = kind === "preview" ? entry.previewAbs : entry.fileAbs;
		if (!abs) return text(404, "not found");
		const found = locateFile(entry.dirAbs, abs);
		if (found !== "ok") return text(found === "denied" ? 403 : 404, found);
		return fileResponse(request, abs, "public, max-age=3600");
	}

	const rel = safeRelative(parts.slice(3));
	if (!rel) return text(404, "not found");
	const abs = resolve(entry.dirAbs, rel);
	const found = locateFile(entry.dirAbs, abs);
	if (found !== "ok") return text(found === "denied" ? 403 : 404, found);
	if (entry.type === "web" && /\.html?$/i.test(abs)) {
		if (request.method === "HEAD") {
			return new Response(null, { status: 200, headers: cors({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }) });
		}
		let html = "";
		try {
			html = readFileSync(abs, "utf8");
		} catch {
			return text(500, "read failed");
		}
		return new Response(injectWebHtml(html, entry, abs), {
			status: 200,
			headers: cors({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }),
		});
	}
	return fileResponse(request, abs, "public, max-age=3600");
}

function ensureProtocol(): void {
	if (handled) return;
	try {
		protocol.handle(SCHEME, (request) =>
			handleRequest(request).catch((error: unknown) => {
				console.error("wallpaper:", error);
				return text(500, "error");
			}),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/already/i.test(message)) throw error;
	}
	handled = true;
}

function originPayload(): WallpaperOrigin {
	ensureProtocol();
	return { base: baseUrl(), live: wallpaperEngineDir() !== null };
}

async function play(request: WallpaperPlayRequest): Promise<WallpaperPlay | null> {
	if (!request || typeof request.id !== "string") return null;
	const fit = request.fit === "contain" || request.fit === "stretch" ? request.fit : "cover";
	const muted = request.muted !== false;
	const library = await ensureLibrary(false);
	const entry = library.entries.get(request.id);
	if (!entry || entry.type === "application") return null;
	const poster = entry.previewAbs ? `${baseUrl()}/preview/${encodeURIComponent(entry.id)}` : null;
	const described = {
		poster,
		schemeColor: entry.schemeColor,
		title: entry.title,
		type: entry.type,
	};
	if (entry.type === "video" && entry.fileAbs && existsSync(entry.fileAbs)) {
		return { ...described, kind: "video", url: `${baseUrl()}/media/${encodeURIComponent(entry.id)}` };
	}
	if ((entry.type === "scene" || entry.type === "web") && wallpaperEngineDir()) {
		const params = new URLSearchParams({
			type: entry.type,
			fit,
			sceneFps: "30",
			muted: muted ? "true" : "false",
		});
		if (entry.type === "web") {
			const rel = entry.file.replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
			params.set("src", `${baseUrl()}/files/${encodeURIComponent(entry.id)}/${rel}`);
			params.set("mediaBase", `${SCHEME}://${HOST}`);
		} else {
			params.set("src", entry.id);
			params.set("mediaBase", `${baseUrl()}/files`);
		}
		return { ...described, kind: "live", url: `${baseUrl()}/live/index.html?${params}` };
	}
	if (!poster) return null;
	return { ...described, kind: "image", url: poster };
}

export function registerWallpaperIpc(): void {
	userDataDir = app.getPath("userData");
	token = randomBytes(16).toString("hex");
	ensureProtocol();

	ipcMain.handle("wallpaper:origin", (): WallpaperOrigin => originPayload());
	ipcMain.handle("wallpaper:library", async (_event, refresh: unknown): Promise<WallpaperLibrary> => {
		const cache = await ensureLibrary(refresh === true);
		return {
			installed: cache.installed,
			installDir: cache.installDir,
			wallpapers: [...cache.entries.values()].map(publish),
		};
	});
	ipcMain.handle("wallpaper:uploads", async (): Promise<WallpaperUpload[]> =>
		(await readUploads()).map((item) => ({ id: item.id, name: item.name })),
	);
	ipcMain.handle("wallpaper:chooseImage", async (event): Promise<WallpaperChooseResult> => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) return { ok: false, error: "failed" };
		return chooseImage(window);
	});
	ipcMain.handle("wallpaper:removeUpload", async (_event, id: unknown): Promise<void> => {
		if (typeof id !== "string") return;
		const items = await readUploads();
		const record = items.find((item) => item.id === id);
		if (!record) return;
		await rm(uploadPath(record), { force: true });
		await writeUploads(items.filter((item) => item.id !== id));
	});
	ipcMain.handle("wallpaper:play", (_event, request: WallpaperPlayRequest) => play(request));
}
