import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AcpTransport } from "./connection";

/** Stderr kept per agent for the error it dies with; an agent can be chatty. */
const STDERR_KEEP = 4000;

/**
 * An agent this app runs, spoken to over its stdin/stdout.
 *
 * Framing is newline-delimited JSON. Stderr is drained rather than ignored:
 * a misconfigured agent usually explains itself there and then exits, and
 * without it the only symptom would be a connection that closed.
 *
 * ACP's own, not MCP's: MCP servers go through pi-mcp, whose transport speaks
 * only MCP's handshake.
 */
export class StdioTransport implements AcpTransport {
	private child: ChildProcessWithoutNullStreams | null;
	private buffer = "";
	private stderr = "";
	private messageListener: ((message: unknown) => void) | null = null;
	private closeListener: ((reason: string) => void) | null = null;
	private closed = false;

	constructor(options: {
		command: string;
		args: string[];
		env: Record<string, string>;
		unsetEnv?: string[];
		cwd: string;
		/** Defaults to a shell on Windows; an absolute executable needs none. */
		shell?: boolean;
	}) {
		const env = { ...process.env, ...options.env };
		for (const key of options.unsetEnv ?? []) delete env[key];
		this.child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			// Agents are commonly `npx …`, which on Windows is a shell script.
			shell: options.shell ?? process.platform === "win32",
			// A GUI app spawning a console program gets a console window otherwise.
			windowsHide: true,
		});

		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_KEEP);
		});
		this.child.on("error", (error) => this.die(error.message));
		this.child.on("close", (code) =>
			this.die(this.stderr.trim() || `代理进程退出（code ${String(code)}）`),
		);
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				try {
					this.messageListener?.(JSON.parse(line));
				} catch {
					// A line that is not JSON is an agent writing logs to stdout.
					// Skipping it keeps the session usable; killing it would not.
				}
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	private die(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.child = null;
		this.closeListener?.(reason);
	}

	async send(message: object): Promise<void> {
		const child = this.child;
		if (!child) throw new Error("代理进程已断开");
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
				error ? reject(error) : resolve(),
			);
		});
	}

	onMessage(listener: (message: unknown) => void): void {
		this.messageListener = listener;
	}

	onClose(listener: (reason: string) => void): void {
		this.closeListener = listener;
	}

	close(): void {
		const child = this.child;
		this.closed = true;
		this.child = null;
		if (child) killProcessTree(child);
	}
}

/**
 * On Windows the child is `cmd.exe` running the real program (see `shell`
 * above), and killing it leaves `npx` and the node process it started running
 * as orphans. `taskkill /T` takes the whole tree down.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.on("error", () => child.kill());
		return;
	}
	child.kill();
}
