import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ContextCategory, ContextUsage } from "../../shared/agent";

type Counts = Partial<Record<ContextCategory, number>>;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const estimate = (text: string): number => {
	const wide = text.match(/[\u2e80-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
	return Math.ceil((text.length - wide) / 4 + wide);
};

export function codexContextHome(env: Record<string, string | undefined>): string {
	const value = Object.entries(env).find(([key, value]) => key.toUpperCase() === "CODEX_HOME" && value)?.[1];
	return value ? resolve(value.replace(/^~(?=[\\/]|$)/, homedir())) : join(homedir(), ".codex");
}

/** Read only the rollout whose filename AND metadata match this ACP session. No project-file guesses. */
export class CodexContextReader {
	private path: string | undefined;
	private offset = 0;
	private pending = "";
	private decoder = new StringDecoder("utf8");
	private verified = false;
	private counts: Counts = {};
	private base = 0;
	private used: number | undefined;
	private window: number | undefined;
	private mtime = 0;

	constructor(private readonly home: string, private readonly sessionId: string) {}

	private async locate(): Promise<string | undefined> {
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(this.sessionId)) return undefined;
		const walk = async (directory: string, depth: number): Promise<string | undefined> => {
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
				if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${this.sessionId}.jsonl`)) return join(directory, entry.name);
				if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) {
					const found = await walk(join(directory, entry.name), depth + 1);
					if (found) return found;
				}
			}
		};
		try { return await walk(join(this.home, "sessions"), 0); } catch { return undefined; }
	}

	private add(category: ContextCategory, text: string): void {
		this.counts[category] = (this.counts[category] ?? 0) + estimate(text);
	}

	private instructions(text: string, fallback: ContextCategory): void {
		// Only classify tagged instruction blocks, never arbitrary prose mentioning skills or tools.
		const tags: [string, ContextCategory][] = [
			["skills_instructions", "skills"], ["available_skills", "skills"],
			["multi_agent_role", "subagents"], ["multi_agent_mode", "subagents"], ["subagents", "subagents"],
			["tools", "tools"], ["functions", "tools"], ["mcp_tools", "mcp"], ["dynamic_tools", "mcp"],
		];
		for (const [tag, category] of tags) text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"), (block) => {
			this.add(category, block);
			return "";
		});
		this.add(fallback, text);
	}

	private item(payload: Record<string, any>): void {
		if (payload.type === "message") {
			const text = Array.isArray(payload.content) ? payload.content.map((block: unknown) => object(block) && typeof block.text === "string" ? block.text : "").join("\n") : "";
			if (payload.role === "developer") this.instructions(text, "rules");
			else if (payload.role === "system") this.instructions(text, "system");
			else if (payload.role === "user" && /^\s*(?:# AGENTS\.md instructions|<skills_instructions>|<INSTRUCTIONS>)/.test(text)) this.instructions(text, "rules");
			else this.add("conversation", text);
		} else if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(payload.type)) {
			this.add("conversation", JSON.stringify(payload));
		}
	}

	private line(line: string): void {
		let entry: unknown;
		try { entry = JSON.parse(line); } catch { return; }
		if (!object(entry) || !object(entry.payload)) return;
		const payload = entry.payload;
		if (entry.type === "session_meta") {
			this.verified = (payload.id ?? payload.session_id) === this.sessionId;
			if (!this.verified) return;
			const base = typeof payload.base_instructions === "string" ? payload.base_instructions : payload.base_instructions?.text;
			this.base = typeof base === "string" ? estimate(base) : 0;
			this.counts = { system: this.base, rules: 0, skills: 0, subagents: 0, conversation: 0 };
			if (typeof payload.context_window === "number") this.window = payload.context_window;
		}
		if (!this.verified) return;
		if (entry.type === "response_item") this.item(payload);
		if (entry.type === "compacted") {
			if (Array.isArray(payload.replacement_history)) {
				this.counts = { system: this.base, rules: 0, skills: 0, subagents: 0, conversation: 0 };
				for (const item of payload.replacement_history) if (object(item)) this.item(item);
			} else this.counts.conversation = typeof payload.message === "string" ? estimate(payload.message) : 0;
		}
		if (entry.type === "event_msg" && payload.type === "token_count" && object(payload.info)) {
			const used = payload.info.last_token_usage?.total_tokens;
			if (typeof used === "number" && Number.isFinite(used) && used >= 0) this.used = used;
			const window = payload.info.model_context_window;
			if (typeof window === "number" && Number.isFinite(window) && window > 0) this.window = window;
		}
	}

	/** Incremental asynchronous reads keep large histories off the snapshot/render path. */
	async read(reported?: ContextUsage): Promise<ContextUsage | undefined> {
		if (!this.path) this.path = await this.locate();
		if (!this.path) return undefined;
		try {
			const file = await open(this.path, "r");
			try {
				const stat = await file.stat();
				if (stat.size < this.offset || (stat.size === this.offset && stat.mtimeMs !== this.mtime)) {
					this.offset = 0; this.pending = ""; this.decoder = new StringDecoder("utf8");
					this.verified = false; this.counts = {}; this.used = undefined; this.window = undefined;
				}
				const buffer = Buffer.alloc(256 * 1024);
				while (this.offset < stat.size) {
					const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
					if (!bytesRead) break;
					this.offset += bytesRead;
					this.pending += this.decoder.write(buffer.subarray(0, bytesRead));
					let end: number;
					while ((end = this.pending.indexOf("\n")) !== -1) {
						this.line(this.pending.slice(0, end));
						this.pending = this.pending.slice(end + 1);
					}
				}
				this.mtime = stat.mtimeMs;
			} finally { await file.close(); }
		} catch { return undefined; }
		const used = reported?.used ?? this.used;
		const window = reported?.window ?? this.window;
		if (!this.verified || used === undefined || window === undefined || !Number.isFinite(window) || window <= 0) return undefined;
		const total = Object.values(this.counts).reduce((sum, count) => sum + count, 0);
		const scale = total > used ? used / total : 1;
		const breakdown = Object.fromEntries(Object.entries(this.counts).map(([key, value]) => [key, Math.floor(value * scale)]));
		return { used, window, source: "acp", breakdown, breakdownEstimated: true, breakdownSource: "codex-rollout" };
	}
}
