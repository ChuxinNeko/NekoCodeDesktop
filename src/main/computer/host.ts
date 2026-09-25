import type { ComputerCallResult, WorkerRequest, WorkerResponse } from "./protocol";

/** The slice of Electron's `UtilityProcess` the host uses; tests supply a fake. */
export interface WorkerProcess {
	postMessage(message: WorkerRequest): void;
	on(event: "message", listener: (message: WorkerResponse) => void): unknown;
	on(event: "exit", listener: (code: number) => void): unknown;
	kill(): boolean;
}

export interface ComputerHostOptions {
	fork: () => WorkerProcess;
	/** How long a cancelled call may keep running before the worker is killed. */
	cancelGraceMs?: number;
	/** A call still unanswered by now is wedged, and so is the worker. */
	callTimeoutMs?: number;
	startTimeoutMs?: number;
}

interface Pending {
	resolve: (result: ComputerCallResult) => void;
	reject: (error: Error) => void;
}

interface Worker {
	process: WorkerProcess;
	ready: Promise<void>;
	pending: Map<number, Pending>;
}

/**
 * Owns the Computer Use worker process and routes driver calls to it.
 *
 * The worker starts on the first call rather than with the app: most sessions
 * never touch the desktop, and loading the driver costs memory and a native
 * library. A worker that dies is replaced on the next call.
 */
export class ComputerHost {
	private worker: Worker | null = null;
	private nextId = 1;
	private readonly cancelGraceMs: number;
	private readonly callTimeoutMs: number;
	private readonly startTimeoutMs: number;

	constructor(private readonly options: ComputerHostOptions) {
		this.cancelGraceMs = options.cancelGraceMs ?? 1_500;
		this.callTimeoutMs = options.callTimeoutMs ?? 120_000;
		this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
	}

	async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerCallResult> {
		signal?.throwIfAborted();
		const worker = this.start();
		await worker.ready;
		signal?.throwIfAborted();
		const id = this.nextId++;
		return new Promise<ComputerCallResult>((resolve, reject) => {
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				clearTimeout(timeout);
				clearTimeout(graceTimer);
				signal?.removeEventListener("abort", onAbort);
				worker.pending.delete(id);
			};
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Computer Use 调用 ${name} 超时`));
				this.kill(worker, "Computer Use 驱动无响应，已重启");
			}, this.callTimeoutMs);
			const onAbort = () => {
				worker.process.postMessage({ type: "cancel", id });
				// A native input loop does not always notice a cancel. Stopping has to
				// be certain, so a call that keeps running takes the worker with it.
				graceTimer = setTimeout(() => {
					if (!worker.pending.has(id)) return;
					cleanup();
					reject(new Error("已停止"));
					this.kill(worker, "Computer Use 已停止");
				}, this.cancelGraceMs);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			worker.pending.set(id, {
				resolve: (result) => {
					cleanup();
					resolve(result);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			worker.process.postMessage({ type: "call", id, name, args });
		});
	}

	/** End every in-flight action now. The next call starts a fresh worker. */
	stop(): void {
		if (this.worker) this.kill(this.worker, "Computer Use 已停止");
	}

	dispose(): void {
		this.stop();
	}

	private start(): Worker {
		if (this.worker) return this.worker;
		const child = this.options.fork();
		const pending = new Map<number, Pending>();
		let settle!: { resolve: () => void; reject: (error: Error) => void };
		const ready = new Promise<void>((resolve, reject) => {
			settle = { resolve, reject };
		});
		// A start that fails is reported to whoever is waiting on it; nobody may be.
		ready.catch(() => undefined);
		const worker: Worker = { process: child, ready, pending };
		const startTimer = setTimeout(() => {
			settle.reject(new Error("Computer Use 驱动启动超时"));
			this.kill(worker, "Computer Use 驱动启动超时");
		}, this.startTimeoutMs);
		child.on("message", (message) => {
			switch (message.type) {
				case "ready":
					clearTimeout(startTimer);
					settle.resolve();
					return;
				case "fatal":
					clearTimeout(startTimer);
					settle.reject(new Error(`Computer Use 驱动加载失败：${message.message}`));
					this.kill(worker, message.message);
					return;
				case "result":
					pending.get(message.id)?.resolve(message.result);
					return;
				case "error":
					pending.get(message.id)?.reject(new Error(message.message));
					return;
			}
		});
		child.on("exit", (code) => {
			clearTimeout(startTimer);
			settle.reject(new Error(`Computer Use 驱动进程已退出（${code}）`));
			this.release(worker, `Computer Use 驱动进程已退出（${code}）`);
		});
		this.worker = worker;
		return worker;
	}

	private kill(worker: Worker, reason: string): void {
		this.release(worker, reason);
		worker.process.kill();
	}

	/** Forget a worker and fail whatever was still waiting on it. */
	private release(worker: Worker, reason: string): void {
		if (this.worker === worker) this.worker = null;
		for (const pending of [...worker.pending.values()]) pending.reject(new Error(reason));
		worker.pending.clear();
	}
}
