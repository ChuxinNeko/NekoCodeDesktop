import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { BrowserPreviewRequest } from "../shared/browser";
import { devServers as defaultDevServers, type DevServerRegistry } from "./website-clone-dev-server";
import {
	compareExtractions,
	extractionExpression,
	renderComparison,
	type Extraction,
} from "./website-clone-extract";
import { resolveWorkspacePath } from "./workflow-paths";

export const WEBSITE_CLONE_TOOL_NAMES = [
	"browser_navigate",
	"browser_viewport",
	"browser_evaluate",
	"browser_extract",
	"browser_screenshot",
	"browser_action",
	"website_clone_scaffold",
	"website_clone_dev_server",
	"website_clone_compare",
] as const;

const EVALUATE_MAX_CHARS = 100_000;
/** What a saved result shows the model: enough to see its shape, not to re-read it. */
const SAVED_PREVIEW_CHARS = 1_500;
/** A saved result is still one file a builder may be handed; keep it readable. */
const SAVE_MAX_CHARS = 5_000_000;
const EXTRACT_DEFAULT_DEPTH = 10;
const EXTRACT_DEFAULT_NODES = 800;
/** Files the template carries that a scaffolded project must not start with. */
const SCAFFOLD_SKIP = new Set(["node_modules", ".next", ".git", "next-env.d.ts", "tsconfig.tsbuildinfo"]);
const SCREENSHOT_MAX_WIDTH = 2560;
const SCREENSHOT_MAX_HEIGHT = 20_000;
const WAIT_MAX_MS = 10_000;
/**
 * A page call still unanswered by now is wedged rather than slow: across a full
 * clone run the slowest `browser_evaluate` took 3.5s and the slowest viewport
 * change took under a second.
 */
const GUEST_TIMEOUT_MS = 30_000;
/** Capturing a tall page in one frame is legitimately slower than any evaluate. */
const SCREENSHOT_TIMEOUT_MS = 120_000;
/** How long a revealed page gets to report itself visible before the capture gives up. */
const REVEAL_TIMEOUT_MS = 5_000;
const REVEAL_POLL_MS = 100;
/**
 * Emulation is sent to the page's widget and the measuring script to its frame,
 * over different channels, so a measurement can still see the old size. Measured
 * in a real guest, about one call in twenty did.
 */
const VIEWPORT_SETTLE_MS = 2_000;
const VIEWPORT_POLL_MS = 50;
const MEASURE_VIEWPORT = "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })";

interface MeasuredViewport {
	width?: number;
	height?: number;
	dpr?: number;
}

export interface WebsiteCloneGuest {
	getURL(): string;
	getTitle(): string;
	isDestroyed(): boolean;
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	capturePage(): Promise<{ toPNG(): Buffer; getSize(): { width: number; height: number } }>;
	enableDeviceEmulation(parameters: {
		screenPosition: "desktop" | "mobile";
		screenSize?: { width: number; height: number };
		viewPosition?: { x: number; y: number };
		deviceScaleFactor?: number;
		viewSize: { width: number; height: number };
		scale?: number;
	}): void;
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
	/** Bring the automation page's tab on screen so it paints again. */
	revealAutomation(): void;
	watchAutomation(onInvalidate: (reason: string) => void): () => void;
}

/**
 * The page stopped being able to answer, as opposed to answering with a failure.
 *
 * Worth its own type because a click that navigates is a success the caller
 * should hear about, while the same interruption during an evaluate is not.
 */
class GuestUnavailableError extends Error {
	/** The page went away, rather than merely never getting round to replying. */
	readonly pageGone: boolean;
	constructor(message: string, pageGone: boolean) {
		super(message);
		this.pageGone = pageGone;
	}
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

const saveToProperty = Type.Optional(
	Type.String({
		minLength: 1,
		maxLength: 1000,
		description:
			"Workspace-relative .json/.md/.txt path. The full result is written there and only a short preview comes back — use it for every research artifact instead of re-typing the result with the write tool.",
	}),
);

const evaluateSchema = Type.Object(
	{
		expression: Type.String({ minLength: 1, maxLength: 30_000 }),
		saveTo: saveToProperty,
	},
	{ additionalProperties: false },
);

const extractSchema = Type.Object(
	{
		targets: Type.Array(
			Type.Object(
				{
					name: Type.String({ minLength: 1, maxLength: 80 }),
					selector: Type.String({ minLength: 1, maxLength: 2000 }),
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				maxItems: 50,
				description:
					"Named elements to extract, e.g. [{\"name\":\"header\",\"selector\":\"header\"},{\"name\":\"hero\",\"selector\":\"main > section:nth-of-type(1)\"}]. Use the same names on the source and the clone so website_clone_compare pairs them.",
			},
		),
		maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 30 })),
		maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
		saveTo: saveToProperty,
	},
	{ additionalProperties: false },
);

const compareSchema = Type.Object(
	{
		a: Type.String({ minLength: 1, maxLength: 1000, description: "Workspace-relative browser_extract output (source, or state before)." }),
		b: Type.String({ minLength: 1, maxLength: 1000, description: "Workspace-relative browser_extract output (clone, or state after)." }),
		match: Type.Optional(
			Type.Union([Type.Literal("text"), Type.Literal("path")], {
				description:
					"text (default): pair nodes by their text — source vs clone. path: pair nodes by tree position — two states of the same page, to record a behavior.",
			}),
		),
		tolerancePx: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
		saveTo: saveToProperty,
	},
	{ additionalProperties: false },
);

const devServerSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]),
		directory: Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "Workspace-relative project root containing package.json, e.g. example-com-clone.",
		}),
		port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
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
	/** Whether the model reading the results can see images. Unknown counts as yes. */
	acceptsImages?: () => boolean;
	devServers?: DevServerRegistry;
}): ToolDefinition[] {
	const { cwd, browser, templateDir, onNavigate } = options;
	const devServers = options.devServers ?? defaultDevServers;

	/** Write a result into the workspace and describe it in a few lines instead. */
	const saveResult = async (path: string, text: string) => {
		if (!/\.(json|md|txt)$/i.test(path)) throw new Error("saveTo must end in .json, .md or .txt");
		if (text.length > SAVE_MAX_CHARS) {
			throw new Error(`The result is ${text.length} characters, over the ${SAVE_MAX_CHARS} a saved file may hold; narrow it`);
		}
		const target = resolveWorkspacePath(cwd, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, text, "utf8");
		const preview = text.length > SAVED_PREVIEW_CHARS ? `${text.slice(0, SAVED_PREVIEW_CHARS)}\n[…]` : text;
		return `Saved ${text.length} characters to ${path}. Preview:\n${preview}`;
	};

	let viewportOverride: { width: number; height: number; deviceScaleFactor: number } | null = null;

	/**
	 * Give up on a page call the moment it can no longer be answered.
	 *
	 * Nothing below this line may be trusted to settle on its own: the agent loop
	 * awaits a tool call unconditionally, so one promise the page will never
	 * resolve stalls the whole run, and because the session reports itself busy
	 * until the run settles, the composer's stop button goes dead with it. Losing
	 * the page, the caller's abort, and a deadline all end the wait here instead.
	 */
	const guarded = <T>(
		limits: { signal?: AbortSignal; timeoutMs?: number },
		operation: () => Promise<T>,
	): Promise<T> => {
		const { signal, timeoutMs = GUEST_TIMEOUT_MS } = limits;
		if (signal?.aborted) return Promise.reject(new Error("Tool call cancelled"));
		return new Promise<T>((resolve, reject) => {
			let unwatch: (() => void) | undefined;
			let done = false;
			const settle = (finish: () => void) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unwatch?.();
				finish();
			};
			const onAbort = () => settle(() => reject(new Error("Tool call cancelled")));
			const timer = setTimeout(
				() =>
					settle(() =>
						reject(
							new GuestUnavailableError(
								`The page did not answer within ${Math.round(timeoutMs / 1000)}s`,
								false,
							),
						),
					),
				timeoutMs,
			);
			unwatch = browser.watchAutomation((reason) =>
				settle(() => reject(new GuestUnavailableError(reason, true))),
			);
			signal?.addEventListener("abort", onAbort, { once: true });
			operation().then(
				(value) => settle(() => resolve(value)),
				(error: unknown) =>
					settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
			);
		});
	};

	const emulate = (guest: WebsiteCloneGuest) => {
		if (!viewportOverride) return;
		const { width, height, deviceScaleFactor } = viewportOverride;
		guest.enableDeviceEmulation({
			screenPosition: "desktop",
			screenSize: { width, height },
			viewPosition: { x: 0, y: 0 },
			deviceScaleFactor,
			viewSize: { width, height },
			scale: 1,
		});
	};

	/**
	 * Keep the requested viewport on the page, and measure it.
	 *
	 * The emulation stays on the page between calls, so a menu opened at 390px is
	 * still open at 390px on the next call instead of being closed by a resize to
	 * the panel's width and back. Any navigation drops it, including a reload, so
	 * it is checked before every call and put back when it is gone — reapplying
	 * the same size fires no resize, but it is only done when needed anyway.
	 */
	const settleViewport = async (guest: WebsiteCloneGuest): Promise<MeasuredViewport | undefined> => {
		if (!viewportOverride) return undefined;
		const { width, height } = viewportOverride;
		const measure = async () =>
			((await guest.executeJavaScript(MEASURE_VIEWPORT, true)) ?? {}) as MeasuredViewport;
		let measured = await measure();
		if (measured.width === width && measured.height === height) return measured;
		emulate(guest);
		const deadline = Date.now() + VIEWPORT_SETTLE_MS;
		for (;;) {
			measured = await measure();
			if (measured.width === width && measured.height === height) return measured;
			if (Date.now() >= deadline) return measured;
			await new Promise((resolve) => setTimeout(resolve, VIEWPORT_POLL_MS));
		}
	};

	const onPage = <T>(
		guest: WebsiteCloneGuest,
		limits: { signal?: AbortSignal; timeoutMs?: number },
		operation: (viewport: MeasuredViewport | undefined) => Promise<T>,
	): Promise<T> =>
		guarded(limits, async () => operation(await settleViewport(guest)));

	/**
	 * Only captures use the debugger. Holding it for every call locked the user
	 * out of DevTools and element picking while a clone ran, and failed every call
	 * outright while DevTools was open on the page.
	 */
	const withDebugger = async <T>(
		guest: WebsiteCloneGuest,
		limits: { signal?: AbortSignal; timeoutMs?: number },
		operation: () => Promise<T>,
	): Promise<T> => {
		const attached = guest.debugger.isAttached();
		if (!attached) guest.debugger.attach("1.3");
		try {
			return await onPage(guest, limits, () => operation());
		} finally {
			// Runs even when `guarded` walked away from a call still pending, so a
			// wedged page cannot leave the debugger pinned to the guest and lock the
			// user out of DevTools and element picking for the rest of the session.
			if (!attached && !guest.isDestroyed()) {
				try {
					guest.debugger.detach();
				} catch {
					/* The page took the debugger session with it. */
				}
			}
			// A clipped capture resets the page's emulation when it finishes.
			if (!guest.isDestroyed()) {
				try {
					emulate(guest);
				} catch {
					/* Checked again before the next call. */
				}
			}
		}
	};

	/**
	 * Every capture path waits for the guest's next compositor frame, and a guest
	 * the panel has hidden (another dock tab in front, the dock collapsed, or a
	 * different browser tab active) never produces one. Bring it on screen first,
	 * and fail fast with the reason rather than sitting out the capture timeout.
	 */
	const ensurePainting = async (guest: WebsiteCloneGuest, signal?: AbortSignal): Promise<void> => {
		const isVisible = async () =>
			(await guarded({ signal }, () => guest.executeJavaScript("document.visibilityState"))) === "visible";
		if (await isVisible()) return;
		browser.revealAutomation();
		const deadline = Date.now() + REVEAL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, REVEAL_POLL_MS));
			if (await isVisible()) return;
		}
		throw new Error(
			"The browser panel is not showing this page, so it cannot be painted for a screenshot. Open the NekoCode window with the browser panel visible, then retry.",
		);
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
			"Set the emulated CSS viewport of the page bound by browser_navigate. Use 1440x900 desktop, 768x900 tablet, 390x844 mobile. The size holds for every later call, across navigations, until changed. Touch input and (hover: none)/(pointer: coarse) media are not emulated; read those rules from the stylesheets instead.",
		parameters: viewportSchema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const { width, height, deviceScaleFactor } = params as Static<typeof viewportSchema>;
			const guest = browser.automationGuest();
			viewportOverride = { width, height, deviceScaleFactor: deviceScaleFactor ?? 1 };
			// Applied up front even at an unchanged size: the scale factor may differ.
			emulate(guest);
			const measured = await onPage(guest, { signal }, async (viewport) => viewport);
			if (measured?.width !== width || measured?.height !== height) {
				throw new Error(
					`Viewport emulation failed: requested ${width}x${height} but page reported ${measured?.width}x${measured?.height}`,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Viewport verified at ${width}x${height} (dpr ${Number(measured.dpr?.toFixed(3))})`,
					},
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
			"Run a JavaScript expression in the inspected page and return its JSON-serialized result, capped at 100k characters (with saveTo, the full result goes to a file and a preview comes back). Use for questions browser_extract does not answer: asset inventories, stylesheet rules, scroll listeners, library detection. The expression must not navigate the page: location.reload(), assigning location.href, and submitting a form all destroy the context the result would come back through. Use browser_navigate to load or reload a page, then evaluate against it.",
		parameters: evaluateSchema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const { expression, saveTo } = params as Static<typeof evaluateSchema>;
			const guest = browser.automationGuest();
			const result = await onPage(guest, { signal }, () => guest.executeJavaScript(expression, true));
			if (saveTo) {
				const full = typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? String(result));
				return {
					content: [{ type: "text", text: await saveResult(saveTo, full) }],
					details: { saveTo, chars: full.length },
				};
			}
			const { text, truncated } = serializeEvaluation(result);
			return {
				content: [{ type: "text", text }],
				details: { truncated },
			};
		},
	};

	const extract: ToolDefinition = {
		name: "browser_extract",
		label: "browser_extract",
		description:
			"Extract named elements of the inspected page with NekoCode's fixed extractor: per node the document rect, own text, key attributes, non-default computed styles (colors normalized to sRGB), ::before/::after, and small inline SVG markup. Run it with the same target names on the source and the clone, or before and after an interaction, then diff the two files with website_clone_compare. Always pass saveTo for anything larger than a single small element.",
		parameters: extractSchema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const { targets, maxDepth, maxNodes, saveTo } = params as Static<typeof extractSchema>;
			const named: Record<string, string> = {};
			for (const { name, selector } of targets) {
				if (name in named) throw new Error(`Duplicate target name: ${name}`);
				named[name] = selector;
			}
			const guest = browser.automationGuest();
			const extraction = (await onPage(guest, { signal }, () =>
				guest.executeJavaScript(
					extractionExpression({
						targets: named,
						maxDepth: maxDepth ?? EXTRACT_DEFAULT_DEPTH,
						maxNodes: maxNodes ?? EXTRACT_DEFAULT_NODES,
					}),
					true,
				),
			)) as Extraction;
			const errors = Object.entries(extraction.targets)
				.filter(([, target]) => "error" in target)
				.map(([name, target]) => `${name}: ${(target as { error: string }).error}`);
			const summary = [
				`Extracted ${extraction.nodes} nodes from ${extraction.url} at ${extraction.viewport.width}x${extraction.viewport.height}, scrollY ${extraction.scroll.y}.`,
				extraction.truncated
					? "Some subtrees were cut by maxDepth/maxNodes (see `omitted`); extract those elements as their own targets."
					: "",
				errors.length ? `Target errors:\n${errors.join("\n")}` : "",
			]
				.filter(Boolean)
				.join("\n");
			if (saveTo) {
				await saveResult(saveTo, JSON.stringify(extraction, null, 1));
				return {
					content: [{ type: "text", text: `${summary}\nSaved to ${saveTo}.` }],
					details: { saveTo, nodes: extraction.nodes, truncated: extraction.truncated },
				};
			}
			const { text, truncated } = serializeEvaluation(extraction);
			return {
				content: [{ type: "text", text: `${summary}\n${text}` }],
				details: { nodes: extraction.nodes, truncated: truncated || extraction.truncated },
			};
		},
	};

	const compare: ToolDefinition = {
		name: "website_clone_compare",
		label: "website_clone_compare",
		description:
			"Diff two browser_extract files target by target: missing or extra text, typography/color/box style differences, rect differences beyond tolerancePx (default 2), and image/video/SVG count and size. match=text compares a source with its clone; match=path compares two states of one page to record exactly what an interaction changes. Take both extractions at the same viewport.",
		parameters: compareSchema,
		executionMode: "sequential",
		async execute(_id, params) {
			const { a, b, match, tolerancePx, saveTo } = params as Static<typeof compareSchema>;
			const read = async (path: string) => {
				const text = await readFile(resolveWorkspacePath(cwd, path), "utf8");
				const parsed = JSON.parse(text) as Extraction;
				if (!parsed || typeof parsed !== "object" || !parsed.targets || !parsed.viewport) {
					throw new Error(`${path} is not a browser_extract result`);
				}
				return parsed;
			};
			const comparison = compareExtractions(await read(a), await read(b), {
				mode: match ?? "text",
				tolerancePx,
				labels: [a, b],
			});
			const report = renderComparison(comparison);
			if (saveTo) {
				const full = saveTo.toLowerCase().endsWith(".json")
					? JSON.stringify(comparison, null, 1)
					: renderComparison(comparison, Number.POSITIVE_INFINITY);
				await saveResult(saveTo, full);
			}
			return {
				content: [{ type: "text", text: report + (saveTo ? `\n\nFull report saved to ${saveTo}.` : "") }],
				details: { issues: comparison.issues.length, counts: comparison.counts },
			};
		},
	};

	const devServer: ToolDefinition = {
		name: "website_clone_dev_server",
		label: "website_clone_dev_server",
		description:
			"Start, check, or stop a project's dev server without blocking. start runs its dev script with the package manager its lockfile names and returns the local URL the server actually printed; status returns whether it runs plus its recent output, where compile errors appear; stop ends it and its child processes. Never start a dev server through bash or powershell — those wait for it to exit, which it never does.",
		parameters: devServerSchema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const { action, directory, port } = params as Static<typeof devServerSchema>;
			const root = resolveWorkspacePath(cwd, directory);
			const shown = relative(resolveWorkspacePath(cwd, "."), root) || ".";
			const status =
				action === "start"
					? await devServers.start(root, shown, { port, signal })
					: action === "stop"
						? devServers.stop(root, shown)
						: devServers.status(root, shown);
			const head =
				action === "stop"
					? `Stopped the dev server in ${shown}.`
					: status.running
						? `Dev server in ${shown} is running${status.url ? ` at ${status.url}` : ", no URL printed yet"}.`
						: `No dev server is running in ${shown}${status.exitCode !== undefined ? ` (exited with ${status.exitCode})` : ""}.`;
			return {
				content: [{ type: "text", text: status.log ? `${head}\nRecent output:\n${status.log}` : head }],
				details: { ...status, log: undefined },
			};
		},
	};

	const screenshot: ToolDefinition = {
		name: "browser_screenshot",
		label: "browser_screenshot",
		description:
			"Save a PNG screenshot of the inspected page inside the workspace and attach the image to the result for direct visual inspection. fullPage captures the whole scroll height, capped at 2560x20000.",
		parameters: screenshotSchema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const { path, fullPage } = params as Static<typeof screenshotSchema>;
			if (!/\.png$/i.test(path)) throw new Error("Screenshot path must end in .png");
			const target = resolveWorkspacePath(cwd, path);
			const guest = browser.automationGuest();
			await ensurePainting(guest, signal);
			const captured = await withDebugger(
				guest,
				{ signal, timeoutMs: SCREENSHOT_TIMEOUT_MS },
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
						// The clip is in document coordinates: start it where the page is
						// scrolled to, or a section screenshot shows the top of the page.
						const [x, y] = ((await guest.executeJavaScript("[scrollX, scrollY]", true)) as
							| [number, number]
							| null) ?? [0, 0];
						const shot = (await guest.debugger.sendCommand("Page.captureScreenshot", {
							format: "png",
							captureBeyondViewport: true,
							clip: {
								x,
								y,
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
			const saved = `Saved ${path} (${captured.width}x${captured.height}${captured.capped ? ", capped" : ""})`;
			// Said outright, so the model knows which QA path it is on instead of
			// describing an image the provider silently dropped.
			const attached = options.acceptsImages?.() ?? true;
			return {
				content: attached
					? [
							{ type: "text", text: `${saved}. The image is attached.` },
							{ type: "image", data: captured.bytes.toString("base64"), mimeType: "image/png" },
						]
					: [
							{
								type: "text",
								text: `${saved}. The active model does not accept images, so it is not attached: the file is for the user. Rely on browser_extract and website_clone_compare for QA.`,
							},
						],
				details: {
					path,
					width: captured.width,
					height: captured.height,
					fullPage: Boolean(fullPage),
					capped: captured.capped,
					attached,
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
			// A click that follows a link tears the page down mid-call. The interaction
			// itself landed; only the scroll probe behind it can no longer come back, so
			// report the navigation rather than the probe that was lost to it.
			let interacted = false;
			const interact = async () => {
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
				interacted = true;
				const position = await guest.executeJavaScript("window.scrollY", true);
				return {
					content: [{ type: "text" as const, text: `${action} done on ${guest.getURL()}` }],
					details: { action, url: guest.getURL(), scrollY: typeof position === "number" ? position : 0 },
				};
			};
			try {
				return await onPage(
					guest,
					{ signal, timeoutMs: GUEST_TIMEOUT_MS + WAIT_MAX_MS },
					interact,
				);
			} catch (error) {
				const navigatedAway =
					interacted && !guest.isDestroyed() && error instanceof GuestUnavailableError && error.pageGone;
				if (!navigatedAway) throw error;
				return {
					content: [{ type: "text", text: `${action} done, then the page navigated to ${guest.getURL()}` }],
					details: { action, url: guest.getURL(), scrollY: 0, navigated: true },
				};
			}
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
			// It becomes the package name too, so it has to be one npm accepts.
			if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/.test(name)) {
				throw new Error(
					`Directory must be lowercase letters, digits, ".", "_" or "-", like example-com-clone: ${directory}`,
				);
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
			await cp(templateDir, target, {
				recursive: true,
				force: false,
				errorOnExist: true,
				// Packaged, the template ships clean; from a checkout it may hold an
				// install or a build someone ran while working on it.
				filter: (source) => source === templateDir || !SCAFFOLD_SKIP.has(basename(source)),
			});
			// Named after its directory, in the lockfile too, so the first install
			// does not rewrite a file the user has not touched yet.
			const manifestPath = join(target, "package.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
			manifest.name = name;
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
			const lockPath = join(target, "package-lock.json");
			const lock = await readFile(lockPath, "utf8").then(
				(text) => JSON.parse(text) as { name?: string; packages?: Record<string, { name?: string }> },
				() => null,
			);
			if (lock) {
				lock.name = name;
				if (lock.packages?.[""]) lock.packages[""].name = name;
				await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
			}
			const entries = await readdir(target);
			return {
				content: [{ type: "text", text: `Scaffolded ${name} (${entries.length} top-level entries)` }],
				details: { directory: name, entries },
			};
		},
	};

	return [navigate, viewport, evaluate, extract, screenshot, action, scaffold, devServer, compare];
}
