import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebsiteCloneTools, type WebsiteCloneGuest } from "./website-clone-tools";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const guest: WebsiteCloneGuest = {
	getURL: () => "https://example.com",
	getTitle: () => "Example",
	isDestroyed: () => false,
	executeJavaScript: (code) => Promise.resolve(code === "document.visibilityState" ? "visible" : null),
	capturePage: () =>
		Promise.resolve({ toPNG: () => PNG, getSize: () => ({ width: 800, height: 600 }) }),
	enableDeviceEmulation: () => undefined,
	sendInputEvent: () => undefined,
	debugger: {
		isAttached: () => true,
		attach: () => undefined,
		detach: () => undefined,
		sendCommand: () => Promise.resolve({}),
	},
};

const browser = {
	requestAutomation: () => Promise.resolve(guest),
	automationGuest: () => guest,
	revealAutomation: () => undefined,
	watchAutomation: () => () => undefined,
};

/** A guest the panel is hiding until `revealAutomation` is called (if ever). */
function hiddenBrowser(revealWorks: boolean) {
	let visible = false;
	let captures = 0;
	let reveals = 0;
	const hidden: WebsiteCloneGuest = {
		...guest,
		executeJavaScript: (code) =>
			Promise.resolve(code === "document.visibilityState" ? (visible ? "visible" : "hidden") : null),
		capturePage: () => {
			captures++;
			return guest.capturePage();
		},
	};
	return {
		host: {
			...browser,
			automationGuest: () => hidden,
			revealAutomation: () => {
				reveals++;
				if (revealWorks) visible = true;
			},
		},
		counts: () => ({ captures, reveals }),
	};
}

const dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("browser_screenshot", () => {
	test("saves the PNG and attaches it to the tool result", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nekocode-shot-"));
		dirs.push(cwd);
		const tools = createWebsiteCloneTools({
			cwd,
			browser,
			templateDir: null,
			onNavigate: () => undefined,
		});
		const tool = tools.find((t) => t.name === "browser_screenshot")!;
		const result = await tool.execute("call-1", { path: "shot.png" }, undefined, undefined, {} as never);
		const written = await readFile(join(cwd, "shot.png"));
		expect(written.equals(PNG)).toBe(true);
		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe("text");
		const image = result.content[1];
		expect(image.type).toBe("image");
		if (image.type === "image") {
			expect(image.mimeType).toBe("image/png");
			expect(Buffer.from(image.data, "base64").equals(PNG)).toBe(true);
		}
		expect(result.details).toMatchObject({ path: "shot.png", width: 800, height: 600 });
	});

	test("brings a hidden page on screen before capturing it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nekocode-shot-"));
		dirs.push(cwd);
		const { host, counts } = hiddenBrowser(true);
		const tools = createWebsiteCloneTools({ cwd, browser: host, templateDir: null, onNavigate: () => undefined });
		const tool = tools.find((t) => t.name === "browser_screenshot")!;
		await tool.execute("call-2", { path: "shot.png" }, undefined, undefined, {} as never);
		expect(counts()).toEqual({ captures: 1, reveals: 1 });
	});

	test("fails with the reason instead of waiting on a page that cannot paint", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nekocode-shot-"));
		dirs.push(cwd);
		const { host, counts } = hiddenBrowser(false);
		const tools = createWebsiteCloneTools({ cwd, browser: host, templateDir: null, onNavigate: () => undefined });
		const tool = tools.find((t) => t.name === "browser_screenshot")!;
		await expect(
			tool.execute("call-3", { path: "shot.png" }, undefined, undefined, {} as never),
		).rejects.toThrow("browser panel is not showing this page");
		expect(counts()).toEqual({ captures: 0, reveals: 1 });
	}, 15_000);
});

describe("browser_viewport", () => {
	test("keeps the emulated size on the page for every later call", async () => {
		const emulated: number[] = [];
		let width = 1024;
		let height = 768;
		const page: WebsiteCloneGuest = {
			...guest,
			enableDeviceEmulation: (parameters) => {
				emulated.push(parameters.viewSize.width);
				width = parameters.viewSize.width;
				height = parameters.viewSize.height;
			},
			executeJavaScript: () => Promise.resolve({ width, height, dpr: 1 }),
		};
		const tools = createWebsiteCloneTools({
			cwd: tmpdir(),
			browser: { ...browser, automationGuest: () => page },
			templateDir: null,
			onNavigate: () => undefined,
		});
		const run = (name: string, params: object) =>
			tools.find((t) => t.name === name)!.execute("call", params as never, undefined, undefined, {} as never);
		await run("browser_viewport", { width: 390, height: 844 });
		// A navigation drops the emulation; the next call must put it back.
		width = 1024;
		await run("browser_evaluate", { expression: "1" });
		expect(emulated).toEqual([390, 390]);
		expect(width).toBe(390);
	});
});

/**
 * A page that behaves like an emulated guest: its viewport follows
 * `enableDeviceEmulation`, and it records the debugger traffic.
 */
function emulatedPage(initial = { width: 1024, height: 768 }) {
	const state = { ...initial, scrollY: 0, emulations: 0, attaches: 0, commands: [] as Array<{ method: string; params?: Record<string, unknown> }> };
	const page: WebsiteCloneGuest = {
		...guest,
		enableDeviceEmulation: (parameters) => {
			state.emulations++;
			state.width = parameters.viewSize.width;
			state.height = parameters.viewSize.height;
		},
		executeJavaScript: (code) => {
			if (code === "document.visibilityState") return Promise.resolve("visible");
			if (code === "[scrollX, scrollY]") return Promise.resolve([0, state.scrollY]);
			if (code.startsWith("({ width: innerWidth")) return Promise.resolve({ width: state.width, height: state.height, dpr: 1 });
			return Promise.resolve({ answer: 42, list: [1, 2, 3] });
		},
		debugger: {
			isAttached: () => false,
			attach: () => {
				state.attaches++;
			},
			detach: () => undefined,
			sendCommand: (method, params) => {
				state.commands.push({ method, params });
				return Promise.resolve(method === "Page.captureScreenshot" ? { data: PNG.toString("base64") } : {});
			},
		},
	};
	return { page, state };
}

function toolsFor(page: WebsiteCloneGuest, cwd = tmpdir(), extra: { acceptsImages?: () => boolean; templateDir?: string } = {}) {
	const tools = createWebsiteCloneTools({
		cwd,
		browser: { ...browser, automationGuest: () => page },
		templateDir: extra.templateDir ?? null,
		onNavigate: () => undefined,
		acceptsImages: extra.acceptsImages,
	});
	return (name: string, params: object) =>
		tools.find((t) => t.name === name)!.execute("call", params as never, undefined, undefined, {} as never);
}

describe("page calls", () => {
	test("leave the debugger alone and do not re-emulate a viewport that held", async () => {
		const { page, state } = emulatedPage();
		const run = toolsFor(page);
		await run("browser_viewport", { width: 390, height: 844 });
		await run("browser_evaluate", { expression: "1" });
		await run("browser_action", { action: "scroll", scrollY: 200 });
		expect(state.emulations).toBe(1);
		expect(state.attaches).toBe(0);
	});

	test("evaluate saveTo writes the full result and returns a preview", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nekocode-eval-"));
		dirs.push(cwd);
		const { page } = emulatedPage();
		const result = await toolsFor(page, cwd)("browser_evaluate", { expression: "x", saveTo: "research/a.json" });
		expect(JSON.parse(await readFile(join(cwd, "research", "a.json"), "utf8"))).toEqual({ answer: 42, list: [1, 2, 3] });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toStartWith("Saved ");
		await expect(toolsFor(page, cwd)("browser_evaluate", { expression: "x", saveTo: "a.png" })).rejects.toThrow(".json");
		await expect(toolsFor(page, cwd)("browser_evaluate", { expression: "x", saveTo: "../a.json" })).rejects.toThrow(
			"outside the workspace",
		);
	});
});

describe("browser_screenshot capture", () => {
	test("clips the viewport where the page is scrolled and puts the emulation back", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nekocode-shot-"));
		dirs.push(cwd);
		const { page, state } = emulatedPage();
		const run = toolsFor(page, cwd);
		await run("browser_viewport", { width: 390, height: 844 });
		state.scrollY = 1200;
		await run("browser_screenshot", { path: "s.png" });
		const capture = state.commands.find((command) => command.method === "Page.captureScreenshot");
		expect(capture?.params?.clip).toEqual({ x: 0, y: 1200, width: 390, height: 844, scale: 1 });
		expect(state.attaches).toBe(1);
		// Applied once by browser_viewport, once after the capture reset it.
		expect(state.emulations).toBe(2);
	});

	test("says so instead of attaching the image for a text-only model", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nekocode-shot-"));
		dirs.push(cwd);
		const result = await toolsFor(guest, cwd, { acceptsImages: () => false })("browser_screenshot", { path: "s.png" });
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).toContain("does not accept images");
		expect(result.details).toMatchObject({ attached: false });
	});
});

describe("website_clone_scaffold", () => {
	test("copies the template without installs or builds and names the package", async () => {
		const templateDir = await mkdtemp(join(tmpdir(), "nekocode-template-"));
		const cwd = await mkdtemp(join(tmpdir(), "nekocode-ws-"));
		dirs.push(templateDir, cwd);
		await writeFile(join(templateDir, "package.json"), JSON.stringify({ name: "ai-website-clone-template", private: true }));
		await mkdir(join(templateDir, "src", "app"), { recursive: true });
		await writeFile(join(templateDir, "src", "app", "page.tsx"), "export default function Page() {}");
		await mkdir(join(templateDir, "node_modules", "next"), { recursive: true });
		await mkdir(join(templateDir, ".next"), { recursive: true });
		const run = toolsFor(guest, cwd, { templateDir });

		await run("website_clone_scaffold", { directory: "example-com-clone" });
		const root = join(cwd, "example-com-clone");
		expect((await readdir(root)).sort()).toEqual(["package.json", "src"]);
		expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({
			name: "example-com-clone",
			private: true,
		});

		await expect(run("website_clone_scaffold", { directory: "Example Clone" })).rejects.toThrow("lowercase");
		await expect(run("website_clone_scaffold", { directory: "example-com-clone" })).rejects.toThrow("not empty");
	});
});
