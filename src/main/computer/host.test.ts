import { describe, expect, test } from "bun:test";
import { ComputerHost, type WorkerProcess } from "./host";
import type { WorkerRequest, WorkerResponse } from "./protocol";

class FakeWorker implements WorkerProcess {
	sent: WorkerRequest[] = [];
	killed = false;
	private messageListeners: ((message: WorkerResponse) => void)[] = [];
	private exitListeners: ((code: number) => void)[] = [];

	postMessage(message: WorkerRequest): void {
		this.sent.push(message);
	}
	on(event: "message" | "exit", listener: (value: never) => void): this {
		if (event === "message") this.messageListeners.push(listener as (message: WorkerResponse) => void);
		else this.exitListeners.push(listener as (code: number) => void);
		return this;
	}
	kill(): boolean {
		this.killed = true;
		this.exit(1);
		return true;
	}
	emit(message: WorkerResponse): void {
		for (const listener of this.messageListeners) listener(message);
	}
	exit(code: number): void {
		for (const listener of this.exitListeners) listener(code);
	}
	lastCall(): Extract<WorkerRequest, { type: "call" }> {
		const call = this.sent.filter((message) => message.type === "call").at(-1);
		if (!call || call.type !== "call") throw new Error("no call sent");
		return call;
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { cancelGraceMs?: number; callTimeoutMs?: number } = {}) {
	const workers: FakeWorker[] = [];
	const host = new ComputerHost({
		fork: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
		...options,
	});
	return { host, workers };
}

describe("ComputerHost", () => {
	test("starts the worker on first use and routes the result back", async () => {
		const { host, workers } = setup();
		expect(workers.length).toBe(0);
		const pending = host.call("list_windows", { on_screen_only: true });
		workers[0].emit({ type: "ready" });
		await tick();
		const call = workers[0].lastCall();
		expect(call).toMatchObject({ name: "list_windows", args: { on_screen_only: true } });
		workers[0].emit({ type: "result", id: call.id, result: { text: "ok", images: [], isError: false } });
		expect((await pending).text).toBe("ok");
	});

	test("a driver that fails to load rejects the call, and the next call retries", async () => {
		const { host, workers } = setup();
		const first = host.call("list_apps", {});
		workers[0].emit({ type: "fatal", message: "dll missing" });
		await expect(first).rejects.toThrow("dll missing");
		const second = host.call("list_apps", {});
		expect(workers.length).toBe(2);
		workers[1].emit({ type: "ready" });
		await tick();
		workers[1].emit({ type: "result", id: workers[1].lastCall().id, result: { text: "", images: [], isError: false } });
		await expect(second).resolves.toBeDefined();
	});

	test("a cancel the driver ignores kills the worker", async () => {
		const { host, workers } = setup({ cancelGraceMs: 10 });
		const controller = new AbortController();
		const pending = host.call("click", { pid: 1 }, controller.signal);
		workers[0].emit({ type: "ready" });
		await tick();
		controller.abort();
		expect(workers[0].sent.some((message) => message.type === "cancel")).toBe(true);
		await expect(pending).rejects.toThrow("已停止");
		expect(workers[0].killed).toBe(true);
	});

	test("a cancel the driver honours leaves the worker running", async () => {
		const { host, workers } = setup({ cancelGraceMs: 20 });
		const controller = new AbortController();
		const pending = host.call("type_text", { pid: 1, text: "x" }, controller.signal);
		workers[0].emit({ type: "ready" });
		await tick();
		controller.abort();
		workers[0].emit({ type: "error", id: workers[0].lastCall().id, message: "cancelled" });
		await expect(pending).rejects.toThrow("cancelled");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(workers[0].killed).toBe(false);
	});

	test("a worker that exits fails its calls", async () => {
		const { host, workers } = setup();
		const pending = host.call("list_windows", {});
		workers[0].emit({ type: "ready" });
		await tick();
		workers[0].exit(3);
		await expect(pending).rejects.toThrow("3");
	});

	test("a wedged call times out and takes the worker with it", async () => {
		const { host, workers } = setup({ callTimeoutMs: 10 });
		const pending = host.call("drag", { pid: 1 });
		workers[0].emit({ type: "ready" });
		await expect(pending).rejects.toThrow("超时");
		expect(workers[0].killed).toBe(true);
	});

	test("stop ends every in-flight call", async () => {
		const { host, workers } = setup();
		const pending = host.call("scroll", { pid: 1 });
		workers[0].emit({ type: "ready" });
		await tick();
		host.stop();
		await expect(pending).rejects.toThrow("已停止");
		expect(workers[0].killed).toBe(true);
	});
});
