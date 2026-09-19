import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { BrowserPreviewRequest } from "../shared/browser";
import { resolveWorkspacePath } from "./workflow-paths";

export const WEBSITE_CLONE_TOOL_NAMES = [
	"browser_navigate",
	"browser_viewport",
	"browser_evaluate",
	"browser_screenshot",
	"browser_action",
	"website_clone_scaffold",
] as const;

const EVALUATE_MAX_CHARS = 100_000;
const SCREENSHOT_MAX_WIDTH = 2560;
const SCREENSHOT_MAX_HEIGHT = 20_000;
const WAIT_MAX_MS = 10_000;

export interface WebsiteCloneGuest {
	getURL(): string;
	getTitle(): string;
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	capturePage(): Promise<{ toPNG(): Buffer; getSize(): { width: number; height: number } }>;
	sendInputEvent(
		event:
			| { type: "mouseMove"; x: number; y: number }
			| {
					type: "mouseDown" | "mouseUp";
					x: number;
					y: number;
					button: "left" | "middle" | "right";
					clickCount: number;
			  },
	): void;
	debugger: {
		isAttached(): boolean;
		attach(protocolVersion?: string): void;
		detach(): void;
		sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
	};
}

export interface WebsiteCloneBrowserHost {
	requestAutomation(
		requestId: string,
		open: () => void,
		signal?: AbortSignal,
	): Promise<WebsiteCloneGuest>;
	automationGuest(): WebsiteCloneGuest;
}

interface LayoutMetrics {
	cssContentSize?: { width: number; height: number };
	contentSize?: { width: number; height: number };
}

export function resolveWebsiteCloneTemplateDir(options: {
	appPath: string;
	resourcesPath?: string;
	override?: string;
}): string | null {
	const candidates = [
		options.override,
		options.resourcesPath ? join(options.resourcesPath, "templates", "website-cloner") : undefined,
		join(options.appPath, "resources", "templates", "website-cloner"),
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {}
	}
	return null;
}

const navigateSchema = Type.Object(
	{
		url: Type.String({ minLength: 1, maxLength: 4000 }),
	},
	{ additionalProperties: false },
);

const viewportSchema = Type.Object(
	{
		width: Type.Integer({ minimum: 320, maximum: 2560 }),
		height: Type.Integer({ minimum: 320, maximum: 2560 }),
		deviceScaleFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
	},
	{ additionalProperties: false },
);

const evaluateSchema = Type.Object(
	{
		expression: Type.String({ minLength: 1, maxLength: 30_000 }),
	},
	{ additionalProperties: false },
);

const screenshotSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 1000 }),
		fullPage: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const actionSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("click"),
			Type.Literal("hover"),
			Type.Literal("scroll"),
			Type.Literal("type"),
			Type.Literal("wait"),
		]),
		selector: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		scrollY: Type.Optional(Type.Number({ minimum: 0 })),
		text: Type.Optional(Type.String({ maxLength: 10_000 })),
		waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: WAIT_MAX_MS })),
	},
	{ additionalProperties: false },
);

const scaffoldSchema = Type.Object(
	{
		directory: Type.String({ minLength: 1, maxLength: 120 }),
	},
	{ additionalProperties: false },
);

function serializeEvaluation(result: unknown): { text: string; truncated: boolean } {
	const serialized = typeof result === "string" ? result : JSON.stringify(result);
	let text = serialized === undefined ? String(result) : serialized;
	if (text.length > EVALUATE_MAX_CHARS) {
		return { text: `${text.slice(0, EVALUATE_MAX_CHARS)}\n[truncated at ${EVALUATE_MAX_CHARS} chars]`, truncated: true };
	}
	return { text, truncated: false };
}

function elementCenter(selector: string): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return null;
		el.scrollIntoView({ block: "center", inline: "center" });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	})()`;
}

export function createWebsiteCloneTools(options: {
	cwd: string;
	browser: WebsiteCloneBrowserHost;
	templateDir: string | null;
	onNavigate(request: Omit<BrowserPreviewRequest, "sessionId" | "cwd">): void;
}): ToolDefinition[] {
	const { cwd, browser, templateDir, onNavigate } = options;

	let viewportOverride: { width: number; height: number; deviceScaleFactor: number } | null = null;

	const withViewport = async <T>(guest: WebsiteCloneGuest, operation: () => Promise<T>): Promise<T> => {
		const attached = guest.debugger.isAttached();
		if (!attached) guest.debugger.attach("1.3");
		try {
			if (viewportOverride) {
				await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
					...viewportOverride,
					mobile: false,
				});
			}
			return await operation();
		} finally {
			if (!attached) guest.debugger.detach();
		}
	};

	const navigate: ToolDefinition = {
		name: "browser_navigate",
		label: "browser_navigate",
		description:
			"Open an http(s) URL in the visible NekoCode browser panel and wait for its page guest. Returns the final URL and title.",
		parameters: navigateSchema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const { url: raw } = params as Static<typeof navigateSchema>;
			const trimmed = raw.trim();
			const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
			let url: URL;
			try {
				url = new URL(candidate);
			} catch {
				throw new Error(`Not a URL: ${raw}`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error(`Only http(s) pages can be inspected in the browser panel: ${raw}`);
			}
			const requestId = randomUUID();
			const guest = await browser.requestAutomation(
				requestId,
				() => onNavigate({ id: requestId, url: url.toString(), kind: "automation" }),
				signal,
			);
			return {
				content: [{ type: "text", text: `Navigated to ${guest.getURL()}` }],
				details: { url: guest.getURL(), title: guest.getTitle() },
			};
		},
	};

	const viewport: ToolDefinition = {
		name: "browser_viewport",
		label: "browser_viewport",
		description:
			"Set the emulated CSS viewport of the page bound by browser_navigate. Use 1440x900 desktop, 768x900 tablet, 390x844 mobile.",
		parameters: viewportSchema,
		executionMode: "sequential",
		async execute(_id, params) {
			const { width, height, deviceScaleFactor } = params as Static<typeof viewportSchema>;
			const guest = browser.automationGuest();
			viewportOverride = { width, height, deviceScaleFactor: deviceScaleFactor ?? 1 };
			const measured = await withViewport(guest, async () => {
				return (await guest.executeJavaScript(
					"({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
					true,
				)) as { width?: number; height?: number; dpr?: number };
			});
			if (measured?.width !== width || measured?.height !== height) {
				throw new Error(
					`Viewport emulation failed: requested ${width}x${height} but page reported ${measured?.width}x${measured?.height}`,
				);
			}
			return {
				content: [
					{ type: "text", text: `Viewport verified at ${width}x${height} (dpr ${measured.dpr})` },
				],
				details: {
					width,
					height,
					deviceScaleFactor: deviceScaleFactor ?? 1,
					measuredWidth: measured.width,
					measuredHeight: measured.height,
					measuredDpr: measured.dpr,
				},
			};
		},
	};

	const evaluate: ToolDefinition = {
		name: "browser_evaluate",
		label: "browser_evaluate",
		description:
			"Run a JavaScript expression in the inspected page and return its JSON-serialized result, capped at 100k characters. Use for DOM, computed-style, content, asset, and interaction extraction.",
		parameters: evaluateSchema,
		executionMode: "sequential",
		async execute(_id, params) {
			const { expression } = params as Static<typeof evaluateSchema>;
			const guest = browser.automationGuest();
			const result = await withViewport(guest, () => guest.executeJavaScript(expression, true));
			const { text, truncated } = serializeEvaluation(result);
			return {
				content: [{ type: "text", text }],
				details: { truncated },
			};
		},
	};

	const screenshot: ToolDefinition = {
		name: "browser_screenshot",
		label: "browser_screenshot",
		description:
			"Save a PNG screenshot of the inspected page inside the workspace. fullPage captures the whole scroll height, capped at 2560x20000.",
		parameters: screenshotSchema,
		executionMode: "sequential",
		async execute(_id, params) {
			const { path, fullPage } = params as Static<typeof screenshotSchema>;
			if (!/\.png$/i.test(path)) throw new Error("Screenshot path must end in .png");
			const target = resolveWorkspacePath(cwd, path);
			const guest = browser.automationGuest();
			const captured = await withViewport(
				guest,
				async (): Promise<{ bytes: Buffer; width: number; height: number; capped: boolean }> => {
					if (fullPage) {
						const metrics = (await guest.debugger.sendCommand("Page.getLayoutMetrics")) as LayoutMetrics;
						const content = metrics.cssContentSize ?? metrics.contentSize;
						let width = Math.ceil(content?.width ?? 0);
						let height = Math.ceil(content?.height ?? 0);
						const capped = width > SCREENSHOT_MAX_WIDTH || height > SCREENSHOT_MAX_HEIGHT;
						width = Math.min(Math.max(width, 1), SCREENSHOT_MAX_WIDTH);
						height = Math.min(Math.max(height, 1), SCREENSHOT_MAX_HEIGHT);
						const shot = (await guest.debugger.sendCommand("Page.captureScreenshot", {
							format: "png",
							captureBeyondViewport: true,
							clip: { x: 0, y: 0, width, height, scale: 1 },
						})) as { data: string };
						return { bytes: Buffer.from(shot.data, "base64"), width, height, capped };
					}
					if (viewportOverride) {
						const shot = (await guest.debugger.sendCommand("Page.captureScreenshot", {
							format: "png",
							captureBeyondViewport: true,
							clip: {
								x: 0,
								y: 0,
								width: viewportOverride.width,
								height: viewportOverride.height,
								scale: 1,
							},
						})) as { data: string };
						return {
							bytes: Buffer.from(shot.data, "base64"),
							width: viewportOverride.width,
							height: viewportOverride.height,
							capped: false,
						};
					}
					const image = await guest.capturePage();
					const size = image.getSize();
					return { bytes: image.toPNG(), width: size.width, height: size.height, capped: false };
				},
			);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, captured.bytes);
			return {
				content: [
					{
						type: "text",
						text: `Saved ${path} (${captured.width}x${captured.height}${captured.capped ? ", capped" : ""})`,
					},
				],
				details: {
					path,
					width: captured.width,
					height: captured.height,
					fullPage: Boolean(fullPage),
					capped: captured.capped,
				},
			};
		},
	};

	const action: ToolDefinition = {
		name: "browser_action",
		label: "browser_action",
		description:
			"Interact with the inspected page: click, hover, scroll to a Y offset, type into a field, or wait. Scroll an element into view before clicking it.",
		parameters: actionSchema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const { action, selector, scrollY, text, waitMs } = params as Static<typeof actionSchema>;
			const guest = browser.automationGuest();
			return withViewport(guest, async () => {
				switch (action) {
					case "click":
					case "hover": {
						if (!selector) throw new Error(`${action} requires a selector`);
						const rect = (await guest.executeJavaScript(elementCenter(selector), true)) as
							| { x: number; y: number }
							| null;
						if (!rect) throw new Error(`No element matches selector: ${selector}`);
						const x = Math.round(rect.x);
						const y = Math.round(rect.y);
						guest.sendInputEvent({ type: "mouseMove", x, y });
						if (action === "click") {
							guest.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
							guest.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
						}
						break;
					}
					case "scroll": {
						if (typeof scrollY !== "number" || scrollY < 0) throw new Error("scroll requires scrollY >= 0");
						await guest.executeJavaScript(`window.scrollTo(0, ${Math.floor(scrollY)})`, true);
						break;
					}
					case "type": {
						if (!selector) throw new Error("type requires a selector");
						if (typeof text !== "string") throw new Error("type requires text");
						const typed = await guest.executeJavaScript(
							`(() => {
							const el = document.querySelector(${JSON.stringify(selector)});
							if (!el) return false;
							el.focus();
							const proto = el instanceof HTMLTextAreaElement
								? HTMLTextAreaElement.prototype
								: el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
							const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
							if (setter) setter.call(el, ${JSON.stringify(text)});
							else el.value = ${JSON.stringify(text)};
							el.dispatchEvent(new Event("input", { bubbles: true }));
							el.dispatchEvent(new Event("change", { bubbles: true }));
							return true;
						})()`,
							true,
						);
						if (typed !== true) throw new Error(`No element matches selector: ${selector}`);
						break;
					}
					case "wait": {
						if (signal?.aborted) throw new Error("Tool call cancelled");
						const ms = Math.min(Math.max(waitMs ?? 0, 0), WAIT_MAX_MS);
						await new Promise<void>((resolve, reject) => {
							const finish = () => {
								clearTimeout(timer);
								signal?.removeEventListener("abort", abort);
								resolve();
							};
							const abort = () => {
								clearTimeout(timer);
								signal?.removeEventListener("abort", abort);
								reject(new Error("Tool call cancelled"));
							};
							const timer = setTimeout(finish, ms);
							signal?.addEventListener("abort", abort, { once: true });
						});
						break;
					}
				}
				const position = await guest.executeJavaScript("window.scrollY", true);
				return {
					content: [{ type: "text", text: `${action} done on ${guest.getURL()}` }],
					details: { action, url: guest.getURL(), scrollY: typeof position === "number" ? position : 0 },
				};
			});
		},
	};

	const scaffold: ToolDefinition = {
		name: "website_clone_scaffold",
		label: "website_clone_scaffold",
		description:
			"Copy the bundled Next.js website-clone template into a new direct child directory of the workspace. Never overwrites: the destination must be absent or empty.",
		parameters: scaffoldSchema,
		executionMode: "sequential",
		async execute(_id, params) {
			const { directory } = params as Static<typeof scaffoldSchema>;
			const name = directory.trim();
			if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
				throw new Error("Directory must be a direct child name, not a path: " + directory);
			}
			if (!templateDir || !(await stat(templateDir).catch(() => undefined))?.isDirectory()) {
				throw new Error("The bundled website-clone template is not available in this install");
			}
			const target = resolveWorkspacePath(cwd, name);
			const existing = await readdir(target).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (existing && existing.length > 0) {
				throw new Error(`Destination already exists and is not empty: ${name}`);
			}
			await cp(templateDir, target, { recursive: true, force: false, errorOnExist: true });
			const entries = await readdir(target);
			return {
				content: [{ type: "text", text: `Scaffolded ${name} (${entries.length} top-level entries)` }],
				details: { directory: name, entries },
			};
		},
	};

	return [navigate, viewport, evaluate, screenshot, action, scaffold];
}
