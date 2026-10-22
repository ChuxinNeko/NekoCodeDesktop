import { describe, expect, test } from "bun:test";
import { createParser } from "@openuidev/react-lang";
import { createOpenUIRuntime, openuiStorageKey, MAX_OPENUI_STATE_BYTES } from "../../../src/renderer/src/lib/openuiRuntime";
import { openuiProgramAllowsWrite } from "../../../src/renderer/src/lib/openuiProgram";
import { openuiLibrary } from "../../../src/renderer/src/lib/openuiLibrary";
import { OPENUI_TRACKER_EXAMPLE } from "../../../src/renderer/src/lib/openuiExamples";
import { createOpenUIHostActions, type OpenUIHostScope } from "../../../src/renderer/src/lib/openuiActions";

function memoryStorage() {
	const map = new Map<string, string>();
	return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}

describe("local application runtime", () => {
	test("records and reactive/form state survive a remount; other apps remain isolated", async () => {
		const storage = memoryStorage();
		const key = openuiStorageKey("session", "message", 12)!;
		const runtime = createOpenUIRuntime({ key, storage, canWrite: () => true });
		expect(await runtime.callTool("app_list", { collection: "tasks" })).toEqual({ rows: [], total: 0 });
		const { row } = await runtime.callTool("app_save", { collection: "tasks", record: { title: "Build", done: false, count: 0 } }) as { row: { id: string } };
		runtime.setState({ $count: 4, form: { name: { value: "Draft" } } });
		const restored = createOpenUIRuntime({ key, storage, canWrite: () => true });
		expect(restored.getState()).toEqual({ $count: 4, form: { name: { value: "Draft" } } });
		await restored.callTool("app_save", { collection: "tasks", record: { id: row.id, title: "Updated", done: true } });
		expect(await restored.callTool("app_list", { collection: "tasks" })).toEqual({ rows: [{ id: row.id, title: "Updated", done: true }], total: 1 });
		const other = createOpenUIRuntime({ key: openuiStorageKey("session", "message", 13), storage });
		expect(await other.callTool("app_list", { collection: "tasks" })).toEqual({ rows: [], total: 0 });
		await restored.callTool("app_delete", { collection: "tasks", id: row.id });
		expect(await restored.callTool("app_list", { collection: "tasks" })).toEqual({ rows: [], total: 0 });
	});
	test("unknown tools, malformed args and undeclared writes cannot modify data", async () => {
		const runtime = createOpenUIRuntime();
		await expect(runtime.callTool("app_save", { collection: "tasks", record: {} })).rejects.toThrow("Mutation");
		await expect(runtime.callTool("execute", { command: "bad" })).rejects.toThrow("Unsupported");
		runtime.setWriteGuard(() => true);
		for (const collection of ["__proto__", "constructor", "../data", ""]) await expect(runtime.callTool("app_save", { collection, record: {} })).rejects.toThrow();
		await expect(runtime.callTool("app_save", { collection: "tasks", record: { id: 0 } })).rejects.toThrow("id");
		runtime.setWriteGuard(undefined);
		await expect(runtime.callTool("app_delete", { collection: "tasks", id: "1" })).rejects.toThrow("Mutation");
	});
	test("returned data cannot mutate the store, and a failed durable save is not reported as success", async () => {
		const runtime = createOpenUIRuntime({ canWrite: () => true });
		await runtime.callTool("app_save", { collection: "items", record: { id: "1", title: "Original" } });
		const result = await runtime.callTool("app_list", { collection: "items" }) as { rows: Array<{ title: string }> };
		result.rows[0].title = "Corrupt";
		expect(await runtime.callTool("app_list", { collection: "items" })).toMatchObject({ rows: [{ title: "Original" }] });
		const failed = createOpenUIRuntime({ key: "app", storage: { getItem: () => null, setItem: () => { throw new Error("Quota"); } }, canWrite: () => true });
		await expect(failed.callTool("app_save", { collection: "items", record: {} })).rejects.toThrow("saved");
		expect(failed.storageError).toBe(true);
		expect(await failed.callTool("app_list", { collection: "items" })).toEqual({ rows: [], total: 0 });
	});
	test("corrupt persisted data and oversized changes fail without crashing the UI", () => {
		const runtime = createOpenUIRuntime({ key: "app", storage: { getItem: () => "invalid JSON", setItem: () => {} } });
		expect(runtime.getState()).toEqual({});
		expect(runtime.storageError).toBe(true);
		runtime.setState({ huge: "x".repeat(MAX_OPENUI_STATE_BYTES + 1) });
		expect(runtime.getState()).toEqual({});
	});
});

test("writes are allowed only for declared mutations and never for automatic queries", () => {
	const parser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
	expect(openuiProgramAllowsWrite(parser.parse(OPENUI_TRACKER_EXAMPLE), "app_save")).toBe(true);
	for (const query of ['Query("app_save", {}, {})', 'Query($tool, {}, {})']) {
		const program = parser.parse(`root = Stack([])\nsave = Mutation("app_save", {})\nunsafe = ${query}`);
		expect(openuiProgramAllowsWrite(program, "app_save")).toBe(false);
	}
	expect(openuiProgramAllowsWrite(parser.parse("root = Stack([])"), "app_save")).toBe(false);
});

test("project JSON queries keep the existing scoped reader and reject stale, truncated or non-JSON results", async () => {
	const identity = {};
	const scope: OpenUIHostScope = { identity, active: true, disabled: false, cwd: "project", sessionId: "session" };
	let result: unknown = { kind: "text", text: '{"rows":[1,2]}', truncated: false };
	let reads = 0;
	const host = createOpenUIHostActions(() => scope, async () => { reads++; return result; });
	expect(await host.readProjectJson("data.json")).toEqual({ rows: [1, 2] });
	await expect(host.readProjectJson("../secret")).rejects.toThrow();
	expect(reads).toBe(1);
	result = { kind: "text", text: "{}", truncated: true };
	await expect(host.readProjectJson("data.json")).rejects.toThrow("complete");
	result = { kind: "text", text: "invalid JSON", truncated: false };
	await expect(host.readProjectJson("data.json")).rejects.toThrow();
	const stale = createOpenUIHostActions(() => scope, async () => { scope.identity = {}; return { kind: "text", text: "{}", truncated: false }; });
	await expect(stale.readProjectJson("data.json")).rejects.toThrow("Session changed");
});
