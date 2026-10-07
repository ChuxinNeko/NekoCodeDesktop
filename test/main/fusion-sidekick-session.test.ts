import { describe, expect, test } from "bun:test";
import { FusionSidekickSession } from "../../src/main/fusion-sidekick-session";

const resource = () => ({
	tools: [] as string[], history: [] as string[], disposed: false, aborts: 0,
	async abort() { this.aborts++; },
	dispose() { this.disposed = true; },
	setActiveToolsByName(names: string[]) { this.tools = names; },
});
type Lease = { paths: string[]; permission: string; signal?: AbortSignal };

describe("persistent Fusion Sidekick", () => {
	test("keeps conversation history but replaces authority for every task", async () => {
		const pool = new FusionSidekickSession<ReturnType<typeof resource>, Lease>();
		const first = { paths: ["src/a"], permission: "auto" };
		let creates = 0;
		const create = async () => { creates++; return resource(); };
		const session = await pool.acquire("models", first, create);
		session.history.push("implemented A");
		session.tools = ["edit"];
		pool.release(first, true);
		expect(pool.current).toBeUndefined();
		expect(session.tools).toEqual([]);
		const second = { paths: ["src/b"], permission: "read-only" };
		expect(await pool.acquire("models", second, create)).toBe(session);
		expect(session.history).toEqual(["implemented A"]);
		expect(pool.current).toBe(second);
		expect(pool.current!.paths).not.toContain("src/a");
		expect(creates).toBe(1);
		pool.reset(); await pool.whenSettled();
	});
	test("never leases one session concurrently", async () => {
		const pool = new FusionSidekickSession<ReturnType<typeof resource>, Lease>();
		await pool.acquire("models", { paths: ["."], permission: "auto" }, async () => resource());
		await expect(pool.acquire("models", { paths: ["."], permission: "auto" }, async () => resource()))
			.rejects.toThrow("already leased");
		pool.reset(); await pool.whenSettled();
	});
	test("failure and configuration changes retire rather than reuse the old session", async () => {
		const pool = new FusionSidekickSession<ReturnType<typeof resource>, Lease>();
		const lease = { paths: ["."], permission: "auto" };
		const first = await pool.acquire("old", lease, async () => resource());
		pool.release(lease, false);
		await pool.whenSettled();
		expect(first.aborts).toBe(1); expect(first.disposed).toBe(true);
		const second = await pool.acquire("old", lease, async () => resource());
		pool.release(lease, true);
		const third = await pool.acquire("new", lease, async () => resource());
		expect(second.disposed).toBe(true); expect(third).not.toBe(second);
		pool.reset(); await pool.whenSettled();
	});
	test("invalidated setup cannot publish a resource or regain authority", async () => {
		const pool = new FusionSidekickSession<ReturnType<typeof resource>, Lease>();
		const created = resource();
		let finish!: (value: typeof created) => void;
		let began!: () => void;
		const started = new Promise<void>((resolve) => { began = resolve; });
		const pending = pool.acquire("models", { paths: ["."], permission: "auto" }, () => {
			began(); return new Promise((resolve) => { finish = resolve; });
		});
		await started;
		pool.reset(); finish(created);
		await expect(pending).rejects.toThrow("invalidated");
		await pool.whenSettled();
		expect(created.disposed).toBe(true); expect(pool.current).toBeUndefined();
	});
	test("retirement waits for abort before disposing", async () => {
		const pool = new FusionSidekickSession<ReturnType<typeof resource>, Lease>();
		const created = resource();
		let finish!: () => void;
		created.abort = () => new Promise<void>((resolve) => { finish = resolve; });
		await pool.acquire("models", { paths: ["."], permission: "auto" }, async () => created);
		pool.reset(); await Promise.resolve();
		expect(created.disposed).toBe(false); expect(pool.current).toBeUndefined();
		finish(); await pool.whenSettled(); expect(created.disposed).toBe(true);
	});
});
