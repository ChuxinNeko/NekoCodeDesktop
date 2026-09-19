import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createWebsiteCloneTools,
	resolveWebsiteCloneTemplateDir,
	type WebsiteCloneBrowserHost,
	type WebsiteCloneGuest,
} from "./website-clone-tools";

const temporary: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-clone-tools-"));
	temporary.push(dir);
	return dir;
}

afterEach(() => {
	while (temporary.length) rmSync(temporary.pop() ?? "", { recursive: true, force: true });
});

function fakeHost(options?: {
	evaluate?: (code: string) => unknown;
	layoutMetrics?: unknown;
	ignoreEmulation?: boolean;
}): {
	host: WebsiteCloneBrowserHost;
	guest: WebsiteCloneGuest;
	navigations: Array<{ id: string; url: string; kind: string }>;
	inputEvents: Array<{ type: string }>;
	commands: Array<{ method: string; params: unknown }>;
} {
	const inputEvents: Array<{ type: string }> = [];
	const commands: Array<{ method: string; params: unknown }> = [];
	const navigations: Array<{ id: string; url: string; kind: string }> = [];
	let attached = false;
	let emulation: { width: number; height: number; dpr: number } | null = null;
	const physical = () => ({ width: 399, height: 737, dpr: 1 });
	const guest: WebsiteCloneGuest = {
		getURL: () => "https://example.com/",
		getTitle: () => "Example",
		executeJavaScript: async (code: string) => {
			if (options?.evaluate) return options.evaluate(code);
			if (code === "viewport" || code.includes("innerWidth")) {
				return emulation ?? physical();
			}
			if (code.includes("document.querySelector")) {
				return code.includes('"#ok"') ? { x: 10, y: 20 } : null;
			}
			if (code.includes("window.scrollTo")) return undefined;
			if (code === "window.scrollY") return 0;
			return undefined;
		},
		capturePage: async () => ({
			toPNG: () => Buffer.from("png-bytes"),
			getSize: () => physical(),
		}),
		sendInputEvent: (event) => inputEvents.push(event),
		debugger: {
			isAttached: () => attached,
			attach: () => { attached = true; },
			detach: () => { attached = false; emulation = null; },
			sendCommand: async (method: string, params?: Record<string, unknown>) => {
				commands.push({ method, params });
				if (method === "Emulation.setDeviceMetricsOverride" && !options?.ignoreEmulation) {
					const p = params as { width: number; height: number; deviceScaleFactor: number };
					emulation = { width: p.width, height: p.height, dpr: p.deviceScaleFactor };
				}
				if (method === "Page.getLayoutMetrics") {
					return options?.layoutMetrics ?? { cssContentSize: { width: 1440, height: 3000 } };
				}
				if (method === "Page.captureScreenshot") {
					return { data: Buffer.from("full-png").toString("base64") };
				}
				return {};
			},
		},
	};
	const host: WebsiteCloneBrowserHost = {
		requestAutomation: async (requestId, open) => {
			open();
			return guest;
		},
		automationGuest: () => guest,
	};
	return { host, guest, navigations, inputEvents, commands };
}

function toolsFor(
	host: WebsiteCloneBrowserHost,
	navigations: Array<{ id: string; url: string; kind: string }>,
	options?: { cwd?: string; templateDir?: string | null },
) {
	return createWebsiteCloneTools({
		cwd: options?.cwd ?? workspace(),
		browser: host,
		templateDir: options?.templateDir ?? null,
		onNavigate: (request) => navigations.push(request),
	});
}

function toolNamed(tools: ReturnType<typeof createWebsiteCloneTools>, name: string) {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`missing tool ${name}`);
	return tool;
}

async function run(
	tool: ReturnType<typeof createWebsiteCloneTools>[number],
	params: Record<string, unknown>,
) {
	return tool.execute("call-1", params, undefined, undefined, undefined as never);
}

describe("resolveWebsiteCloneTemplateDir", () => {
	test("prefers the override, then resources, then the checkout", () => {
		const override = workspace();
		const resourcesPath = join(workspace(), "resources");
		mkdirSync(join(resourcesPath, "templates", "website-cloner"), { recursive: true });
		const appPath = join(workspace(), "app");
		mkdirSync(join(appPath, "resources", "templates", "website-cloner"), { recursive: true });
		expect(
			resolveWebsiteCloneTemplateDir({ appPath, resourcesPath, override }),
		).toBe(override);
		expect(resolveWebsiteCloneTemplateDir({ appPath, resourcesPath })).toBe(
			join(resourcesPath, "templates", "website-cloner"),
		);
		expect(resolveWebsiteCloneTemplateDir({ appPath })).toBe(
			join(appPath, "resources", "templates", "website-cloner"),
		);
	});

	test("returns null when nothing bundled exists", () => {
		expect(resolveWebsiteCloneTemplateDir({ appPath: workspace() })).toBeNull();
	});
});

describe("website_clone_scaffold", () => {
	test("rejects the workspace root and nested or escaping names", async () => {
		const { host, navigations } = fakeHost();
		const cwd = workspace();
		const tools = toolsFor(host, navigations, { cwd, templateDir: workspace() });
		const scaffold = toolNamed(tools, "website_clone_scaffold");
		for (const directory of [".", "..", "a/b", "a\\b", "/abs"]) {
			await expect(run(scaffold, { directory })).rejects.toThrow();
		}
		expect(readdirSync(cwd)).toEqual([]);
	});

	test("rejects a non-empty destination before copying", async () => {
		const { host, navigations } = fakeHost();
		const cwd = workspace();
		mkdirSync(join(cwd, "clone"));
		writeFileSync(join(cwd, "clone", "existing.txt"), "keep");
		const templateDir = workspace();
		writeFileSync(join(templateDir, "package.json"), "{}");
		const tools = toolsFor(host, navigations, { cwd, templateDir });
		const scaffold = toolNamed(tools, "website_clone_scaffold");
		await expect(run(scaffold, { directory: "clone" })).rejects.toThrow("not empty");
		expect(readdirSync(join(cwd, "clone"))).toEqual(["existing.txt"]);
	});

	test("rejects when the template is not bundled", async () => {
		const { host, navigations } = fakeHost();
		const tools = toolsFor(host, navigations, { templateDir: null });
		const scaffold = toolNamed(tools, "website_clone_scaffold");
		await expect(run(scaffold, { directory: "clone" })).rejects.toThrow("not available");
	});

	test("copies the template into a direct child directory", async () => {
		const { host, navigations } = fakeHost();
		const cwd = workspace();
		const templateDir = workspace();
		writeFileSync(join(templateDir, "package.json"), "{}");
		mkdirSync(join(templateDir, "src", "app"), { recursive: true });
		writeFileSync(join(templateDir, "src", "app", "page.tsx"), "export default function Page() {}");
		const tools = toolsFor(host, navigations, { cwd, templateDir });
		const scaffold = toolNamed(tools, "website_clone_scaffold");
		const result = await run(scaffold, { directory: "clone" });
		expect(result.details).toMatchObject({ directory: "clone" });
		expect(existsSync(join(cwd, "clone", "package.json"))).toBe(true);
		expect(existsSync(join(cwd, "clone", "src", "app", "page.tsx"))).toBe(true);
	});
});

describe("browser_navigate", () => {
	test("rejects non-http(s) urls before touching the browser", async () => {
		const { host, navigations } = fakeHost();
		const tools = toolsFor(host, navigations);
		const navigate = toolNamed(tools, "browser_navigate");
		for (const url of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)"]) {
			await expect(run(navigate, { url })).rejects.toThrow();
		}
		expect(navigations).toEqual([]);
	});

	test("normalizes and emits an automation preview, then reports the page", async () => {
		const { host, navigations } = fakeHost();
		const tools = toolsFor(host, navigations);
		const navigate = toolNamed(tools, "browser_navigate");
		const result = await run(navigate, { url: "example.com/path" });
		expect(navigations).toHaveLength(1);
		expect(navigations[0]).toMatchObject({
			url: "https://example.com/path",
			kind: "automation",
		});
		expect(navigations[0]?.id).toBeTruthy();
		expect(result.details).toEqual({ url: "https://example.com/", title: "Example" });
	});
});

describe("browser_viewport", () => {
	test("verifies the emulation and replays it for later evaluations", async () => {
		const { host, navigations, commands } = fakeHost();
		const tools = toolsFor(host, navigations);
		const viewport = toolNamed(tools, "browser_viewport");
		const evaluate = toolNamed(tools, "browser_evaluate");
		const applied = () =>
			commands.filter((entry) => entry.method === "Emulation.setDeviceMetricsOverride").length;

		const desktop = await run(viewport, { width: 1440, height: 900, deviceScaleFactor: 1 });
		expect(desktop.details).toMatchObject({
			width: 1440,
			height: 900,
			measuredWidth: 1440,
			measuredHeight: 900,
		});
		const after = await run(evaluate, { expression: "viewport" });
		expect((after.content[0] as { text: string }).text).toBe(
			'{"width":1440,"height":900,"dpr":1}',
		);
		expect(applied()).toBe(2);

		await run(viewport, { width: 390, height: 844 });
		const mobile = await run(evaluate, { expression: "viewport" });
		expect((mobile.content[0] as { text: string }).text).toBe(
			'{"width":390,"height":844,"dpr":1}',
		);
	});

	test("rejects when the page does not report the requested viewport", async () => {
		const { host, navigations } = fakeHost({ ignoreEmulation: true });
		const tools = toolsFor(host, navigations);
		const viewport = toolNamed(tools, "browser_viewport");
		await expect(run(viewport, { width: 1440, height: 900 })).rejects.toThrow(
			"Viewport emulation failed",
		);
	});
});

describe("browser_evaluate", () => {
	test("serializes objects and passes strings through", async () => {
		const { host, navigations } = fakeHost({
			evaluate: (code) => (code === "obj" ? { a: 1 } : "plain"),
		});
		const tools = toolsFor(host, navigations);
		const evaluate = toolNamed(tools, "browser_evaluate");
		const object = await run(evaluate, { expression: "obj" });
		expect(object.content[0]).toEqual({ type: "text", text: '{"a":1}' });
		const plain = await run(evaluate, { expression: "plain" });
		expect(plain.content[0]).toEqual({ type: "text", text: "plain" });
		expect(plain.details).toEqual({ truncated: false });
	});

	test("caps huge results and marks them truncated", async () => {
		const { host, navigations } = fakeHost({ evaluate: () => "x".repeat(150_000) });
		const tools = toolsFor(host, navigations);
		const evaluate = toolNamed(tools, "browser_evaluate");
		const result = await run(evaluate, { expression: "big" });
		const text = (result.content[0] as { text: string }).text;
		expect(result.details).toEqual({ truncated: true });
		expect(text.length).toBeLessThan(101_000);
		expect(text).toContain("[truncated at 100000 chars]");
	});
});

describe("browser_screenshot", () => {
	test("rejects non-png and escaping paths", async () => {
		const { host, navigations } = fakeHost();
		const cwd = workspace();
		const tools = toolsFor(host, navigations, { cwd });
		const screenshot = toolNamed(tools, "browser_screenshot");
		await expect(run(screenshot, { path: "shot.jpg" })).rejects.toThrow(".png");
		await expect(run(screenshot, { path: "../shot.png" })).rejects.toThrow("outside");
		expect(readdirSync(cwd)).toEqual([]);
	});

	test("writes the physical guest png inside the workspace when no viewport is selected", async () => {
		const { host, navigations } = fakeHost();
		const cwd = workspace();
		const tools = toolsFor(host, navigations, { cwd });
		const screenshot = toolNamed(tools, "browser_screenshot");
		const result = await run(screenshot, { path: "refs/shot.png" });
		expect(result.details).toMatchObject({ path: "refs/shot.png", width: 399, height: 737, fullPage: false });
		expect(existsSync(join(cwd, "refs", "shot.png"))).toBe(true);
	});

	test("a viewport screenshot captures the emulated size, not the physical guest", async () => {
		const { host, navigations, commands } = fakeHost();
		const cwd = workspace();
		const tools = toolsFor(host, navigations, { cwd });
		const viewport = toolNamed(tools, "browser_viewport");
		const screenshot = toolNamed(tools, "browser_screenshot");
		await run(viewport, { width: 1440, height: 900, deviceScaleFactor: 1 });
		const result = await run(screenshot, { path: "desk.png" });
		expect(result.details).toMatchObject({ width: 1440, height: 900, fullPage: false });
		const capture = commands
			.filter((entry) => entry.method === "Page.captureScreenshot")
			.at(-1);
		expect(capture?.params).toMatchObject({
			captureBeyondViewport: true,
			clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
		});
		expect(existsSync(join(cwd, "desk.png"))).toBe(true);
	});

	test("full-page capture clips to the content size and reports capping", async () => {
		const { host, navigations, commands } = fakeHost({
			layoutMetrics: { cssContentSize: { width: 3000, height: 30_000 } },
		});
		const cwd = workspace();
		const tools = toolsFor(host, navigations, { cwd });
		const screenshot = toolNamed(tools, "browser_screenshot");
		const result = await run(screenshot, { path: "full.png", fullPage: true });
		expect(result.details).toMatchObject({ width: 2560, height: 20_000, fullPage: true, capped: true });
		const capture = commands.find((entry) => entry.method === "Page.captureScreenshot");
		expect(capture?.params).toMatchObject({ format: "png", captureBeyondViewport: true });
		expect(existsSync(join(cwd, "full.png"))).toBe(true);
	});
});

describe("browser_action", () => {
	test("validates required fields per action", async () => {
		const { host, navigations } = fakeHost();
		const tools = toolsFor(host, navigations);
		const action = toolNamed(tools, "browser_action");
		await expect(run(action, { action: "click" })).rejects.toThrow("selector");
		await expect(run(action, { action: "hover" })).rejects.toThrow("selector");
		await expect(run(action, { action: "scroll" })).rejects.toThrow("scrollY");
		await expect(run(action, { action: "type", selector: "#ok" })).rejects.toThrow("text");
		await expect(run(action, { action: "type", text: "hi" })).rejects.toThrow("selector");
	});

	test("click resolves the element and sends input events", async () => {
		const { host, navigations, inputEvents } = fakeHost();
		const tools = toolsFor(host, navigations);
		const action = toolNamed(tools, "browser_action");
		await run(action, { action: "click", selector: "#ok" });
		expect(inputEvents.map((event) => event.type)).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
	});

	test("click fails clearly when the selector matches nothing", async () => {
		const { host, navigations } = fakeHost();
		const tools = toolsFor(host, navigations);
		const action = toolNamed(tools, "browser_action");
		await expect(run(action, { action: "click", selector: "#missing" })).rejects.toThrow("No element");
	});

	test("wait rejects immediately when the call is already aborted", async () => {
		const { host, navigations } = fakeHost();
		const tools = toolsFor(host, navigations);
		const action = toolNamed(tools, "browser_action");
		const abort = new AbortController();
		abort.abort();
		await expect(
			action.execute(
				"call-1",
				{ action: "wait", waitMs: 10_000 },
				abort.signal,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("cancelled");
	});

	test("wait resolves inside its bound, and abort mid-wait rejects", async () => {
		const { host, navigations } = fakeHost();
		const tools = toolsFor(host, navigations);
		const action = toolNamed(tools, "browser_action");
		await run(action, { action: "wait", waitMs: 5 });
		const abort = new AbortController();
		const pending = action.execute(
			"call-2",
			{ action: "wait", waitMs: 10_000 },
			abort.signal,
			undefined,
			undefined as never,
		);
		abort.abort();
		await expect(pending).rejects.toThrow("cancelled");
	});
});

describe("the bundled website-cloner template", () => {
	test("resolves from the checkout and ships the files the scaffold copies", () => {
		const appPath = join(import.meta.dir, "..", "..");
		const resolved = resolveWebsiteCloneTemplateDir({ appPath });
		expect(resolved).toBe(join(appPath, "resources", "templates", "website-cloner"));
		for (const entry of [
			"package.json",
			"package-lock.json",
			join("src", "app", "page.tsx"),
			"AGENTS.md",
		]) {
			expect(existsSync(join(resolved ?? "", entry))).toBe(true);
		}
	});

	test("pins the production build environment and Turbopack root", () => {
		const appPath = join(import.meta.dir, "..", "..");
		const template = join(appPath, "resources", "templates", "website-cloner");
		const manifest = JSON.parse(readFileSync(join(template, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		expect(manifest.scripts?.build).toBe("cross-env NODE_ENV=production next build");
		expect(manifest.devDependencies?.["cross-env"]).toBe("10.1.0");
		const lock = JSON.parse(readFileSync(join(template, "package-lock.json"), "utf8")) as {
			packages?: Record<string, { devDependencies?: Record<string, string> }>;
		};
		expect(lock.packages?.[""]?.devDependencies?.["cross-env"]).toBe("10.1.0");
		expect(readFileSync(join(template, "next.config.ts"), "utf8")).toContain("root: process.cwd()");
	});
});
