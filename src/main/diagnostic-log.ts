import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Synchronous, bounded writes: a fatal exit must not discard a queued record. */
export class DiagnosticLog {
	readonly path: string;

	constructor(private readonly directory: string, private readonly maxBytes = 1024 * 1024) {
		this.path = join(directory, "diagnostics.jsonl");
	}

	write(event: string, details: Record<string, unknown> = {}): void {
		try {
			const line = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, details }) + "\n";
			// An unexpected payload must not defeat the disk limit.
			if (Buffer.byteLength(line) > this.maxBytes) return;
			mkdirSync(this.directory, { recursive: true });
			let size = 0;
			try { size = statSync(this.path).size; } catch { /* First record. */ }
			if (size + Buffer.byteLength(line) > this.maxBytes) {
				rmSync(`${this.path}.3`, { force: true });
				for (let i = 2; i >= 0; i--) {
					const source = i ? `${this.path}.${i}` : this.path;
					try { renameSync(source, `${this.path}.${i + 1}`); }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				}
			}
			appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
		} catch {
			// Diagnostics must not become a second failure during a crash or disk error.
		}
	}
}

let activeLog: DiagnosticLog | undefined;

export function setDiagnosticLog(log: DiagnosticLog | undefined): void { activeLog = log; }

/** Callers pass only execution metadata, never prompts, command arguments or credentials. */
export function recordDiagnostic(event: string, details: Record<string, unknown> = {}): void {
	activeLog?.write(event, details);
}

export function diagnosticError(error: unknown): Record<string, unknown> {
	return error instanceof Error
		? { name: error.name, message: error.message.slice(0, 2048), stack: error.stack?.slice(0, 8192) }
		: { message: String(error).slice(0, 2048) };
}

/** Observe Node's fatal path without consuming the error or changing exit behavior. */
export function observeProcessDiagnostics(log: DiagnosticLog): void {
	process.on("uncaughtExceptionMonitor", (error, origin) => {
		log.write("process.uncaughtException", { origin, ...diagnosticError(error), memory: process.memoryUsage() });
	});
	process.on("exit", (code) => log.write("process.exit", { code }));
}
