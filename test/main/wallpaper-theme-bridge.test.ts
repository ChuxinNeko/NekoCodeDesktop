import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute the actual cross-origin bridge, not a second copy of its conditions.
const source = readFileSync(new URL("../../src/main/wallpaper/live/renderer.js", import.meta.url), "utf8");
const bridge = source.slice(source.indexOf("// The app window is a different origin"));

function harness() {
	const replies: unknown[][] = [];
	const captures: number[] = [];
	let receive: (event: unknown) => void = () => {};
	const parent = { postMessage: (...args: unknown[]) => replies.push(args) };
	const window = {
		parent,
		__wp: { capture: (size: number) => { captures.push(size); return "data:image/jpeg;base64,test"; } },
		addEventListener: (_type: string, handler: typeof receive) => { receive = handler; },
	};
	runInNewContext(bridge, { window, loadCurrent: () => {} });
	return {
		replies, captures, parent,
		send: (data: unknown, sender: unknown = parent, origin = "null") =>
			receive({ data, source: sender, origin }),
	};
}

describe("wallpaper theme frame bridge", () => {
	test("only the direct parent can ask for a small frame", () => {
		const h = harness();
		const data = { source: "nekocode-wallpaper", type: "theme-capture", requestId: "request-1" };
		h.send(data, { postMessage: () => {} });
		expect(h.captures).toEqual([]);
		h.send(data);
		expect(h.captures).toEqual([64]);
		expect(h.replies).toEqual([[
			{ source: "nekocode-wallpaper-frame", requestId: "request-1", dataUrl: "data:image/jpeg;base64,test" }, "*",
		]]);
	});
	test("wrong channel and malformed request ids never capture", () => {
		const h = harness();
		for (const data of [
			null,
			{ source: "other", type: "theme-capture", requestId: "request" },
			{ source: "nekocode-wallpaper", type: "theme-capture", requestId: 42 },
			{ source: "nekocode-wallpaper", type: "theme-capture", requestId: "x".repeat(81) },
		]) h.send(data);
		expect(h.captures).toEqual([]);
	});
	test("a nonopaque parent origin is preserved as the reply target", () => {
		const h = harness();
		h.send({ source: "nekocode-wallpaper", type: "theme-capture", requestId: "request" }, h.parent, "https://app.test");
		expect(h.replies[0][1]).toBe("https://app.test");
	});
});