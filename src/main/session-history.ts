import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { SessionSummary } from "../shared/agent";

export type SessionHistoryRequest = { id: number; directory: string; cwd?: string };
export type SessionHistoryReply = { id: number } & ({ rows: SessionSummary[] } | { error: string });

/** Session indexing stays off Electron's UI thread. The worker returns rows, never transcripts. */
export class SessionHistoryReader {
	private worker: Worker | undefined;
	private sequence = 0;
	private pending = new Map<number, { resolve: (rows: SessionSummary[]) => void; reject: (cause: Error) => void }>();

	constructor(private workerFile = join(__dirname, "session-list-worker.js")) {}

	list(directory: string, cwd?: string): Promise<SessionSummary[]> {
		if (!this.worker) {
			const worker = new Worker(this.workerFile);
			this.worker = worker;
			worker.on("message", (reply: SessionHistoryReply) => {
				const request = this.pending.get(reply.id);
				if (!request) return;
				this.pending.delete(reply.id);
				if ("error" in reply) request.reject(new Error(reply.error));
				else request.resolve(reply.rows);
			});
			worker.on("error", error => this.failed(worker, error));
			worker.on("exit", code => this.failed(worker, new Error(`Session history worker exited (${code})`)));
			worker.unref();
		}
		const worker = this.worker;
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try { worker.postMessage({ id, directory, cwd } satisfies SessionHistoryRequest); }
			catch (cause) { this.pending.delete(id); reject(cause); }
		});
	}

	private failed(worker: Worker, error: Error) {
		if (this.worker !== worker) return;
		this.worker = undefined;
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}

	close() {
		const worker = this.worker;
		if (!worker) return;
		this.failed(worker, new Error("Session history reader closed"));
		void worker.terminate();
	}
}
