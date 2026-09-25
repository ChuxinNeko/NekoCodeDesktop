import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	FILE_TOOLS,
	hookMatches,
	hookSubject,
	MAX_HOOK_OUTPUT,
	MAX_HOOK_TIMEOUT_MS,
	SHELL_TOOLS,
	validateHook,
	type HookConfig,
	type HookEvent,
	type HookRunRecord,
	type HooksSnapshot,
	type SaveHookRequest,
} from "../shared/hooks";
import { projectKey, projectRoot } from "./project-root";
import { sanitizeNekoShellEnvironment } from "./shell-environment";
import { pi } from "./pi";

const FILE = "hooks.json";
const MAX_HOOKS = 50;
const MAX_RECENT = 50;

interface HooksFile {
	version: 1;
	hooks: HookConfig[];
}

const VALIDATION_MESSAGES: Record<string, string> = {
	name: "请填写 Hook 名称",
	pattern: "匹配规则不是有效的正则表达式",
	command: "请填写要执行的命令",
	timeout: `超时需在 1 到 ${MAX_HOOK_TIMEOUT_MS / 1000} 秒之间`,
};

function normalize(request: SaveHookRequest, id: string): HookConfig {
	return {
		id,
		name: request.name.trim(),
		enabled: request.enabled !== false,
		event: request.event === "post_tool" ? "post_tool" : "pre_tool",
		tools: [...new Set(request.tools.map((tool) => tool.trim()).filter(Boolean))],
		pattern: request.pattern.trim(),
		action: request.event === "post_tool" ? "command" : request.action === "block" ? "block" : "command",
		command: request.command.trim(),
		message: request.message.trim(),
		project: request.project.trim(),
		timeoutMs: Math.round(request.timeoutMs),
	};
}

function isHook(value: unknown): value is HookConfig {
	if (!value || typeof value !== "object") return false;
	const hook = value as Partial<HookConfig>;
	return (
		typeof hook.id === "string" &&
		typeof hook.name === "string" &&
		(hook.event === "pre_tool" || hook.event === "post_tool") &&
		Array.isArray(hook.tools) &&
		typeof hook.pattern === "string" &&
		typeof hook.command === "string"
	);
}

export interface HookCommandResult {
	code: number | null;
	output: string;
	timedOut: boolean;
}

/**
 * Run one hook command in the same shell the agent's own bash tool uses, so a
 * command that works in the terminal drawer works here — including `$VAR` on
 * Windows, where that shell is Git Bash rather than cmd.
 *
 * The call is described twice: as environment variables for a one-liner, and
 * as JSON on stdin for a script that wants all of it.
 */
export async function runHookCommand(options: {
	command: string;
	cwd: string;
	env: Record<string, string>;
	input: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<HookCommandResult> {
	let shell: string;
	let args: string[];
	try {
		const { getShellConfig } = await pi();
		const config = getShellConfig();
		shell = config.shell;
		args = [...config.args, options.command];
	} catch {
		shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
		args = process.platform === "win32" ? ["/d", "/s", "/c", options.command] : ["-c", options.command];
	}
	const env = sanitizeNekoShellEnvironment({
		command: options.command,
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
	}).env;

	return new Promise((done) => {
		let output = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(shell, args, {
			cwd: options.cwd,
			env,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const append = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			// Keep the tail: the end of a lint run is where the summary is.
			if (output.length > MAX_HOOK_OUTPUT * 2) output = output.slice(-MAX_HOOK_OUTPUT);
		};
		const kill = () => {
			if (child.exitCode === null) child.kill();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", kill, { once: true });
		const finish = (code: number | null, extra?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			const text = (output + (extra ?? "")).trim();
			done({ code, output: text.length > MAX_HOOK_OUTPUT ? "…" + text.slice(-MAX_HOOK_OUTPUT) : text, timedOut });
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (error) => finish(null, `\n${error.message}`));
		child.on("close", (code) => finish(code));
		child.stdin.on("error", () => {
			// A command that never reads stdin closes it early; that is not a failure.
		});
		child.stdin.end(options.input);
	});
}

/**
 * The user's hooks: stored here, run around every tool call of every session
 * this app starts.
 */
export class HookService {
	private readonly path: string;
	private hooks: HookConfig[] | null = null;
	private recent: HookRunRecord[] = [];
	private listeners = new Set<(snapshot: HooksSnapshot) => void>();

	constructor(
		userDataDir: string,
		private readonly run: typeof runHookCommand = runHookCommand,
	) {
		mkdirSync(userDataDir, { recursive: true });
		this.path = join(userDataDir, FILE);
	}

	onChange(listener: (snapshot: HooksSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): HookConfig[] {
		if (this.hooks) return this.hooks;
		if (!existsSync(this.path)) return (this.hooks = []);
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<HooksFile>;
			this.hooks = Array.isArray(parsed.hooks)
				? parsed.hooks.filter(isHook).map((hook) => normalize({ ...hook, timeoutMs: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, message: hook.message ?? "", project: hook.project ?? "", action: hook.action ?? "command", enabled: hook.enabled !== false }, hook.id))
				: [];
		} catch (error) {
			throw new Error(`hooks.json 已损坏，请修复或删除后重试：${error instanceof Error ? error.message : String(error)}`);
		}
		return this.hooks;
	}

	snapshot(): HooksSnapshot {
		return { hooks: this.list(), recent: [...this.recent] };
	}

	save(request: SaveHookRequest): HooksSnapshot {
		const problem = validateHook(request);
		if (problem) throw new Error(VALIDATION_MESSAGES[problem] ?? "Hook 配置无效");
		const hooks = this.list();
		const hook = normalize(request, request.id ?? randomUUID());
		const at = hooks.findIndex((entry) => entry.id === hook.id);
		if (at === -1) {
			if (hooks.length >= MAX_HOOKS) throw new Error("Hook 数量已达上限");
			this.hooks = [...hooks, hook];
		} else {
			this.hooks = hooks.map((entry) => (entry.id === hook.id ? hook : entry));
		}
		this.write();
		return this.snapshot();
	}

	remove(id: string): HooksSnapshot {
		this.hooks = this.list().filter((hook) => hook.id !== id);
		this.write();
		return this.snapshot();
	}

	clearRecent(): HooksSnapshot {
		this.recent = [];
		this.emit();
		return this.snapshot();
	}

	/** Enabled hooks for one event that apply to a call in `cwd`. */
	private applicable(event: HookEvent, cwd: string, tool: string, subject: string): HookConfig[] {
		let root: string | null = null;
		return this.list().filter((hook) => {
			if (!hook.enabled || hook.event !== event || !hookMatches(hook, tool, subject)) return false;
			if (!hook.project) return true;
			root ??= projectKey(projectRoot(cwd));
			return projectKey(projectRoot(hook.project)) === root;
		});
	}

	/**
	 * Decide a call before it runs. Returns the refusal, or null to let it
	 * through. Hooks run in the order they were added; the first refusal wins.
	 */
	async beforeTool(cwd: string, tool: string, args: unknown, signal?: AbortSignal): Promise<string | null> {
		const subject = hookSubject(tool, args);
		for (const hook of this.applicable("pre_tool", cwd, tool, subject)) {
			const started = Date.now();
			if (hook.action === "block") {
				const reason = `被 Hook「${hook.name}」拦截${hook.message ? `：${hook.message}` : ""}`;
				this.record(hook, tool, subject, "blocked", hook.message, started);
				return reason;
			}
			const result = await this.execute(hook, "pre_tool", cwd, tool, args, signal);
			if (result.code === 0 && !result.timedOut) {
				this.record(hook, tool, subject, "passed", result.output, started);
				continue;
			}
			this.record(hook, tool, subject, "blocked", result.output, started);
			const why = result.timedOut ? "超时" : `退出码 ${String(result.code)}`;
			return `被 Hook「${hook.name}」拦截（${why}）${result.output ? `：\n${result.output}` : ""}`;
		}
		return null;
	}

	/**
	 * Run the post-tool hooks for a call that succeeded. Returns what the model
	 * should additionally see — the output of every hook that failed — or null
	 * when they all passed quietly.
	 */
	async afterTool(cwd: string, tool: string, args: unknown, signal?: AbortSignal): Promise<string | null> {
		const subject = hookSubject(tool, args);
		const notes: string[] = [];
		for (const hook of this.applicable("post_tool", cwd, tool, subject)) {
			const started = Date.now();
			const result = await this.execute(hook, "post_tool", cwd, tool, args, signal);
			const ok = result.code === 0 && !result.timedOut;
			this.record(hook, tool, subject, ok ? "passed" : "failed", result.output, started);
			if (!ok) {
				const why = result.timedOut ? "超时" : `退出码 ${String(result.code)}`;
				notes.push(`[Hook「${hook.name}」${why}]${result.output ? `\n${result.output}` : ""}`);
			}
		}
		return notes.length ? notes.join("\n\n") : null;
	}

	/**
	 * Wrap a session's tool gates.
	 *
	 * Called after the workflow gate is installed and before the file journal
	 * is, so a call the mode forbids never reaches a hook, and a call a hook
	 * refuses is never recorded as a change.
	 */
	attach(session: AgentSession, cwd: string): void {
		const previousBefore = session.agent.beforeToolCall;
		session.agent.beforeToolCall = async (context, signal) => {
			const result = await previousBefore?.(context, signal);
			if (result?.block) return result;
			const refusal = await this.beforeTool(cwd, context.toolCall.name, context.args, signal);
			return refusal ? { block: true, reason: refusal } : result;
		};

		const previousAfter = session.agent.afterToolCall;
		session.agent.afterToolCall = async (context, signal) => {
			const result = await previousAfter?.(context, signal);
			if (result?.isError ?? context.isError) return result;
			let note: string | null = null;
			try {
				note = await this.afterTool(cwd, context.toolCall.name, context.args, signal);
			} catch (error) {
				// A broken hook must not turn a successful edit into a failed one.
				console.error("Post-tool hook failed:", error);
			}
			if (!note) return result;
			const content = result?.content ?? context.result.content ?? [];
			return { ...result, content: [...content, { type: "text", text: `\n\n${note}` }] };
		};
	}

	private execute(hook: HookConfig, event: HookEvent, cwd: string, tool: string, args: unknown, signal?: AbortSignal) {
		const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
		const env: Record<string, string> = {
			NEKOCODE_HOOK_EVENT: event,
			NEKOCODE_TOOL: tool,
			NEKOCODE_PROJECT_DIR: cwd,
		};
		if ((FILE_TOOLS as readonly string[]).includes(tool) && typeof record.path === "string")
			env.NEKOCODE_FILE = isAbsolute(record.path) ? record.path : resolve(cwd, record.path);
		if ((SHELL_TOOLS as readonly string[]).includes(tool) && typeof record.command === "string")
			env.NEKOCODE_COMMAND = record.command;
		return this.run({
			command: hook.command,
			cwd,
			env,
			input: JSON.stringify({ event, tool, args, cwd }),
			timeoutMs: hook.timeoutMs,
			signal,
		});
	}

	private record(hook: HookConfig, tool: string, subject: string, outcome: HookRunRecord["outcome"], output: string, started: number): void {
		this.recent = [
			{
				hookId: hook.id,
				hookName: hook.name,
				event: hook.event,
				tool,
				subject: subject.length > 300 ? subject.slice(0, 299) + "…" : subject,
				outcome,
				output: output.length > 2000 ? "…" + output.slice(-2000) : output,
				at: Date.now(),
				durationMs: Date.now() - started,
			},
			...this.recent,
		].slice(0, MAX_RECENT);
		this.emit();
	}

	private write(): void {
		const file: HooksFile = { version: 1, hooks: this.list() };
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
		renameSync(temporary, this.path);
		this.emit();
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}
