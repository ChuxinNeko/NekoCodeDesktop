import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebsiteCloneTools, type WebsiteCloneGuest } from "./website-clone-tools";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const guest: WebsiteCloneGuest = {
	getURL: () => "https://example.com",
	getTitle: () => "Example",
	isDestroyed: () => false,
	executeJavaScript: () => Promise.resolve(null),
	capturePage: () =>
		Promise.resolve({ toPNG: () => PNG, getSize: () => ({ width: 800, height: 600 }) }),
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
	watchAutomation: () => () => undefined,
};

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
});
