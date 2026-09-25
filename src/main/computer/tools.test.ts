import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComputerCallResult } from "./protocol";
import {
	COMPUTER_TOOL_NAMES,
	createComputerTools,
	type ComputerCaller,
	type ComputerPointer,
	type PointerAction,
} from "./tools";

function setup(respond: (name: string, args: Record<string, unknown>) => Partial<ComputerCallResult> = () => ({})) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const host: ComputerCaller = {
		async call(name, args) {
			calls.push({ name, args });
			return { text: "ok", images: [], isError: false, ...respond(name, args) };
		},
	};
	const tools = new Map(createComputerTools(host).map((tool) => [tool.name, tool]));
	const run = (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name) as ToolDefinition;
		return (tool.execute as (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[] }>)(
			"call-1",
			params,
			undefined,
			undefined,
			{},
		);
	};
	return { calls, run, tools };
}

const windowState = (snapshotId: string) => () => ({
	text: "window_id=7 pid=42 elements=2\n- [0] Button \"OK\"",
	structuredJson: JSON.stringify({ snapshot_id: snapshotId }),
	images: [{ data: "iVBOR", mimeType: "image/png" }],
});

describe("computer tools", () => {
	test("define every advertised tool", () => {
		const { tools } = setup();
		expect([...tools.keys()].sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
	});

	test("window state returns the tree and the screenshot", async () => {
		const { run } = setup(windowState("s00000001"));
		const result = await run("computer_get_window_state", { pid: 42, window_id: 7 });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	test("an element index is sent with the latest snapshot of its window", async () => {
		let snapshot = "s00000001";
		const { calls, run } = setup((name) => (name === "get_window_state" ? windowState(snapshot)() : {}));
		await run("computer_get_window_state", { pid: 42, window_id: 7 });
		snapshot = "s00000002";
		await run("computer_get_window_state", { pid: 42, window_id: 7 });
		await run("computer_click", { pid: 42, element_index: 0 });
		expect(calls.at(-1)).toEqual({
			name: "click",
			args: { pid: 42, window_id: 7, element_index: 0, snapshot_id: "s00000002" },
		});
	});

	test("an element index without a prior read is refused before reaching the driver", async () => {
		const { calls, run } = setup();
		await expect(run("computer_click", { pid: 42, element_index: 3 })).rejects.toThrow("computer_get_window_state");
		expect(calls.length).toBe(0);
	});

	test("points and elements are not mixed, and a point needs both coordinates", async () => {
		const { run } = setup(windowState("s00000001"));
		await run("computer_get_window_state", { pid: 42, window_id: 7 });
		await expect(run("computer_click", { pid: 42, element_index: 0, x: 1, y: 2 })).rejects.toThrow("not both");
		await expect(run("computer_click", { pid: 42, x: 1 })).rejects.toThrow("together");
		await expect(run("computer_click", { pid: 42 })).rejects.toThrow("element_index or x and y");
	});

	test("foreground delivery is only requested when asked for", async () => {
		const { calls, run } = setup();
		await run("computer_click", { pid: 42, window_id: 7, x: 10, y: 20 });
		expect(calls.at(-1)?.args.delivery_mode).toBeUndefined();
		await run("computer_click", { pid: 42, window_id: 7, x: 10, y: 20, foreground: true });
		expect(calls.at(-1)?.args.delivery_mode).toBe("foreground");
	});

	test("one key is a key press, several are a hotkey", async () => {
		const { calls, run } = setup();
		await run("computer_press_key", { pid: 42, window_id: 7, keys: ["Return"] });
		expect(calls.at(-1)).toMatchObject({ name: "press_key", args: { key: "return" } });
		await run("computer_press_key", { pid: 42, window_id: 7, keys: ["ctrl", "S"] });
		expect(calls.at(-1)).toMatchObject({ name: "hotkey", args: { keys: ["ctrl", "s"] } });
	});

	test("a driver refusal becomes a tool error carrying its code", async () => {
		const { run } = setup(() => ({ isError: true, errorCode: "background_unavailable", text: "posted input dropped" }));
		await expect(run("computer_type_text", { pid: 42, window_id: 7, text: "hi" })).rejects.toThrow(
			"[background_unavailable] posted input dropped",
		);
	});

	test("app listing keeps to running apps unless installed ones are asked for", async () => {
		const apps = [
			{ name: "notepad.exe", pid: 10, running: true, active: true },
			{ name: "Paint", pid: 0, running: false },
		];
		const { run } = setup(() => ({ text: "full list", structuredJson: JSON.stringify({ apps }) }));
		const running = await run("computer_list_apps", {});
		expect(running.content[0].text).toContain("notepad.exe (pid 10) [active]");
		expect(running.content[0].text).not.toContain("Paint");
		const all = await run("computer_list_apps", { include_installed: true });
		expect(all.content[0].text).toBe("full list");
	});

	test("launching needs something to launch", async () => {
		const { calls, run } = setup();
		await expect(run("computer_launch_app", {})).rejects.toThrow("Give one of");
		await run("computer_launch_app", { name: "Notepad", arguments: ["a.txt"] });
		expect(calls.at(-1)).toEqual({ name: "launch_app", args: { name: "Notepad", additional_arguments: ["a.txt"] } });
	});
});

describe("agent cursor", () => {
	const state = () => ({
		text: "tree",
		structuredJson: JSON.stringify({
			snapshot_id: "s00000001",
			window_bounds: { x: 600, y: 200, width: 1200, height: 800 },
			screenshot_width: 600,
			screenshot_height: 400,
			elements: [{ element_index: 4, role: "Button", label: "OK", frame: { x: 700, y: 300, w: 100, h: 40 } }],
		}),
	});

	function withPointer(fail = false) {
		const order: string[] = [];
		const actions: PointerAction[] = [];
		const pointer: ComputerPointer = {
			async act(action) {
				order.push("act");
				actions.push(action);
				if (fail) throw new Error("no display");
			},
			settle() {
				order.push("settle");
			},
		};
		const host: ComputerCaller = {
			async call(name) {
				order.push(name);
				return { text: "ok", images: [], isError: false, ...(name === "get_window_state" ? state() : {}) };
			},
		};
		const tools = new Map(createComputerTools(host, pointer).map((tool) => [tool.name, tool]));
		const run = (name: string, params: Record<string, unknown>) =>
			(tools.get(name)!.execute as (...args: unknown[]) => Promise<unknown>)("id", params, undefined, undefined, {});
		return { order, actions, run };
	}

	test("glides to an element's centre, labelled with what it is, before the click", async () => {
		const { order, actions, run } = withPointer();
		await run("computer_get_window_state", { pid: 1, window_id: 2 });
		await run("computer_click", { pid: 1, element_index: 4 });
		expect(actions[0]).toMatchObject({ kind: "click", label: "点击 · Button OK", at: { x: 750, y: 320 } });
		expect(order).toEqual(["get_window_state", "nekocode.raise_window", "act", "click", "settle"]);
	});

	test("maps screenshot pixels back to the screen when the screenshot is scaled", async () => {
		const { actions, run } = withPointer();
		await run("computer_get_window_state", { pid: 1, window_id: 2 });
		await run("computer_click", { pid: 1, x: 100, y: 50 });
		expect(actions[0].at).toEqual({ x: 800, y: 300 });
	});

	test("without a point, falls back to the window's centre", async () => {
		const { actions, run } = withPointer();
		await run("computer_get_window_state", { pid: 1, window_id: 2 });
		await run("computer_press_key", { pid: 1, keys: ["ctrl", "s"] });
		expect(actions[0]).toMatchObject({ label: "按键 · Ctrl+S", fallback: { x: 1200, y: 600 } });
		expect(actions[0].at).toBeUndefined();
	});

	test("a cursor that cannot be shown does not stop the action", async () => {
		const { order, run } = withPointer(true);
		await run("computer_type_text", { pid: 1, window_id: 2, text: "hello" });
		expect(order).toEqual(["nekocode.raise_window", "act", "type_text", "settle"]);
	});
});

describe("revealing the window", () => {
	test("raises the target window before acting, and not when no cursor is shown", async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		const host: ComputerCaller = {
			async call(name, args) {
				calls.push({ name, args });
				return { text: "ok", images: [], isError: false };
			},
		};
		const pointer: ComputerPointer = { async act() {}, settle() {} };
		const visible = new Map(createComputerTools(host, pointer).map((tool) => [tool.name, tool]));
		await (visible.get("computer_click")!.execute as (...args: unknown[]) => Promise<unknown>)(
			"id",
			{ pid: 1, window_id: 9, x: 5, y: 5 },
			undefined,
			undefined,
			{},
		);
		expect(calls.map((call) => call.name)).toEqual(["nekocode.raise_window", "click"]);
		expect(calls[0].args).toEqual({ window_id: 9 });

		calls.length = 0;
		const hidden = new Map(createComputerTools(host).map((tool) => [tool.name, tool]));
		await (hidden.get("computer_click")!.execute as (...args: unknown[]) => Promise<unknown>)(
			"id",
			{ pid: 1, window_id: 9, x: 5, y: 5 },
			undefined,
			undefined,
			{},
		);
		expect(calls.map((call) => call.name)).toEqual(["click"]);
	});

	test("a window that cannot be raised does not stop the action", async () => {
		const calls: string[] = [];
		const host: ComputerCaller = {
			async call(name) {
				calls.push(name);
				if (name === "nekocode.raise_window") throw new Error("gone");
				return { text: "ok", images: [], isError: false };
			},
		};
		const tools = new Map(createComputerTools(host, { async act() {}, settle() {} }).map((tool) => [tool.name, tool]));
		await (tools.get("computer_press_key")!.execute as (...args: unknown[]) => Promise<unknown>)(
			"id",
			{ pid: 1, window_id: 9, keys: ["return"] },
			undefined,
			undefined,
			{},
		);
		expect(calls).toEqual(["nekocode.raise_window", "press_key"]);
	});
});
