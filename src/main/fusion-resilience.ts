import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";

export const FUSION_RUN_ENTRY = "nekocode.fusion.run.v1";
export const FUSION_REQUEST_TIMEOUT_MS = 240_000;
export const isFusionContinuation = (text: string): boolean =>
	/^(?:继续|接着|恢复|重试|continue\b|resume\b|retry\b)/i.test(text.trim()) && text.length < 500 &&
	!/新任务|另一个任务|改为|换成|\b(?:new task|different task|instead)\b/i.test(text);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Bounded streaming hashing: successful tool status alone cannot prove a changed file. */
export async function fusionFileFingerprint(path: string): Promise<string> {
	let file;
	try { file = await open(path, "r"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
	try {
		const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024);
		while (true) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
		return hash.digest("hex");
	} finally { await file.close(); }
}

export class FusionProgressGuard {
	private requests = 0;
	private tokens = 0;
	private stagnant = 0;
	private failedTurns = 0;
	private handoffs = 0;
	private progressed = false;
	private seen = new Set<string>();
	request(): string | undefined {
		if (this.requests >= 160) return "Fusion reached its 160-request task safety ceiling. Work remains unverified.";
		if (this.tokens >= 10_000_000) return "Fusion reached its 10,000,000 reported-token task safety ceiling. Work remains unverified.";
		this.requests++;
	}
	usage(total: number): void { if (Number.isFinite(total) && total > 0) this.tokens += total; }
	handoff(): string | undefined {
		if (this.handoffs >= 6) return "Fusion stopped six consecutive handoffs without an observed file change. Supply a concrete new decision instead of repeating the plan.";
		this.handoffs++;
	}
	private novel(key: string): boolean {
		const hashed = digest(key);
		if (this.seen.has(hashed) || this.seen.size >= 1024) return false;
		this.seen.add(hashed); this.progressed = true; return true;
	}
	/** A new accepted contract/report is workflow progress, not proof of acceptance.
	 * Deduplication prevents identical ping-pong from replenishing the guard. */
	transition(kind: string, contract: string): void {
		if (this.novel(`transition\n${kind}\n${contract}`)) {
			this.stagnant = 0; this.failedTurns = 0;
		}
	}
	evidence(name: string, path: string, text: string): void {
		if (!["fusion_implement", "fusion_investigate", "fusion_review", "fusion_route_model", "todo_write", "write", "edit", "ast_edit"].includes(name))
			this.novel(`${name}\n${path}\n${text}`);
	}
	write(path: string, before: string, after: string): boolean {
		if (before === after || !this.novel(`file\n${path}\n${after}`)) return false;
		this.handoffs = 0; return true;
	}
	mutationEvidence(path: string, observed: string): boolean {
		if (!this.novel(`mutation\n${path}\n${observed}`)) return false;
		this.handoffs = 0; return true;
	}
	finish(turn: Pick<AgentTurnContext, "message" | "toolResults">): string | undefined {
		const calls = turn.message.content.filter((part) => part.type === "toolCall");
		if (!calls.length) { this.progressed = false; return; }
		const allFailed = turn.toolResults.length > 0 && turn.toolResults.every((result) => result.isError);
		this.failedTurns = allFailed ? this.failedTurns + 1 : 0;
		this.stagnant = this.progressed ? 0 : this.stagnant + 1; this.progressed = false;
		if (this.failedTurns >= 3) return "Fusion stopped three consecutive failed tool turns. Files are preserved; acceptance remains unverified.";
		if (this.stagnant >= 6) return "Fusion stopped six tool turns without new evidence or an actual file change. Files are preserved; acceptance remains unverified.";
	}
	/** Human feedback can resolve a blocker; it never replenishes task request/token budgets. */
	resume(): void { this.stagnant = 0; this.failedTurns = 0; this.handoffs = 0; this.progressed = false; }
	snapshot() { return { requests: this.requests, tokens: this.tokens, stagnant: this.stagnant, failedTurns: this.failedTurns,
		handoffs: this.handoffs, seen: [...this.seen] }; }
	restore(value: unknown): boolean {
		const v = value as ReturnType<FusionProgressGuard["snapshot"]>;
		if (!v || ![v.requests, v.tokens, v.stagnant, v.failedTurns, v.handoffs].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) ||
			!Array.isArray(v.seen) || v.seen.length > 1024 || !v.seen.every((s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))) return false;
		this.requests = v.requests; this.tokens = v.tokens; this.stagnant = v.stagnant; this.failedTurns = v.failedTurns;
		this.handoffs = v.handoffs; this.seen = new Set(v.seen); this.progressed = false; return true;
	}
}

/** Applies to provider waiting only. Clear on assistant completion before tools run. */
export class FusionRequestDeadline {
	private timer?: ReturnType<typeof setTimeout>;
	constructor(private readonly expire: () => void, private readonly milliseconds = FUSION_REQUEST_TIMEOUT_MS) {}
	start(): void { this.clear(); this.timer = setTimeout(() => { this.timer = undefined; this.expire(); }, this.milliseconds); this.timer.unref?.(); }
	clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
