import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { spawn, type IPty } from "node-pty";
import type {
	TerminalCreateRequest,
	TerminalInputRequest,
	TerminalResizeRequest,
	TerminalSession,
} from "../shared/terminal";

const MAX_INPUT_BYTES = 64 * 1024;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

export class TerminalService {
	private ptys = new Map<string, IPty>();

	constructor(private readonly win: BrowserWindow) {}

	create(req: TerminalCreateRequest): TerminalSession {
		if (!existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) {
			throw new Error(`Terminal cwd does not exist: ${req.cwd}`);
		}
		const cols = clamp(req.cols, 2, 500);
		const rows = clamp(req.rows, 1, 300);
		const shell =
			process.env.SHELL ||
			(process.platform === "win32" ? "powershell.exe" : "/bin/bash");
		const args = process.platform === "win32" ? [] : ["-l"];
		const id = randomUUID();
		const pty = spawn(shell, args, {
			name: "xterm-256color",
			cols,
			rows,
			cwd: req.cwd,
			env: {
				...process.env,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			},
		});
		this.ptys.set(id, pty);
		pty.onData((data) => {
			if (!this.win.isDestroyed()) {
				this.win.webContents.send("terminal:data", { id, data });
			}
		});
		pty.onExit(({ exitCode, signal }) => {
			this.ptys.delete(id);
			if (!this.win.isDestroyed()) {
				this.win.webContents.send("terminal:exit", { id, exitCode, signal });
			}
		});
		return { id };
	}

	write(req: TerminalInputRequest): void {
		if (Buffer.byteLength(req.data, "utf8") > MAX_INPUT_BYTES) {
			throw new Error("Terminal input exceeds 64KiB");
		}
		this.ptys.get(req.id)?.write(req.data);
	}

	resize(req: TerminalResizeRequest): void {
		this.ptys
			.get(req.id)
			?.resize(clamp(req.cols, 2, 500), clamp(req.rows, 1, 300));
	}

	kill(id: string): void {
		const pty = this.ptys.get(id);
		if (!pty) return;
		this.ptys.delete(id);
		try {
			pty.kill();
		} catch {
			// already dead
		}
	}

	killAll(): void {
		for (const id of [...this.ptys.keys()]) this.kill(id);
	}
}
