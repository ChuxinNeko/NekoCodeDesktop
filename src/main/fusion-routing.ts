import type { FusionConfig } from "../shared/fusion";

export type FusionAgentIdentity = "main" | "auxiliary";
export type FusionModelRole = "lead" | "sidekick";
export type FusionWorkload = "routine" | "investigation" | "planning" | "review";
export interface FusionRoutingSignal {
	workload: FusionWorkload;
	risk: "low" | "unknown" | "high";
	reason: string;
	evidence: string;
	/** False means return a handoff, not continue unsafe work while waiting for compaction. */
	safeToContinue?: boolean;
}
export interface FusionRouteDecision { role: FusionModelRole; reason: string }

const riskTerms = /\b(security|authorization|authentication|encryption|concurrency|payments?|credentials?|data migration|database migration|permission boundary)\b|鉴权|加密|支付|并发|数据迁移|权限边界/i;
const environmentError = /ECONN\w+|ENOTFOUND|ETIMEDOUT|ENOENT|EACCES|rate.limit|quota|no API key|command not found|not recognized|module not found|cannot find (?:module|package)|network|缺少依赖|网络故障/i;
const correctnessError = /assertion|expected\b|type.?error|type mismatch|invariant|race condition|unhandled|断言|类型错误|结果不一致/i;

/** Local, bounded evidence classifier. No external model call and no permission decisions. */
export class FusionRoutingState {
	private signal: FusionRoutingSignal;
	private explicitRisk = false;
	private successfulActions = 0;
	private failed = new Map<string, { count: number; correctness: boolean; evidence: string }>();
	private environmentalFailures = 0;
	private environmentalSignal = false;
	private switches = 0;
	private failedRoutes = new Set<FusionModelRole>();

	constructor(readonly identity: FusionAgentIdentity, brief = "", routinePlan = false) {
		const high = riskTerms.test(brief);
		this.signal = {
			workload: identity === "main" ? "planning" : routinePlan ? "routine" : "investigation",
			risk: high ? "high" : routinePlan ? "low" : "unknown",
			reason: high ? "Task brief contains correctness-sensitive work" : "Initial task classification",
			evidence: brief.slice(0, 1200), safeToContinue: true,
		};
		this.explicitRisk = high;
	}

	request(value: FusionRoutingSignal): void {
		if (!value.reason.trim() || !value.evidence.trim()) throw new Error("Fusion routing needs concrete evidence");
		// Explicit hints still cannot turn an ordinary endpoint/environment failure into capability risk.
		this.environmentalSignal = environmentError.test(value.evidence) &&
			!correctnessError.test(value.evidence) && !riskTerms.test(value.evidence);
		if (this.environmentalSignal && value.risk === "high") value = { ...value, risk: "unknown" };
		// A successful tool call proves execution, not that a correctness-sensitive
		// requirement has been resolved. Keep explicit high risk for this task.
		if (value.risk === "high") this.explicitRisk = true;
		this.signal = { ...value, reason: value.reason.slice(0, 1000), evidence: value.evidence.slice(0, 2000) };
	}

	observe(tool: string, args: unknown, output: string, isError: boolean): void {
		if (tool.startsWith("fusion_") || ["question", "todo_write", "switch_mode", "task", "code_search"].includes(tool)) return;
		const serialized = typeof args === "string" ? args : JSON.stringify(args) ?? "";
		const key = `${tool}:${serialized.slice(0, 500)}`;
		if (isError) {
			if (environmentError.test(output)) { this.environmentalFailures++; return; }
			const previous = this.failed.get(key);
			this.failed.set(key, { count: (previous?.count ?? 0) + 1,
				correctness: previous?.correctness === true || correctnessError.test(output), evidence: output.slice(-800) });
			const failure = this.failed.get(key)!;
			if (this.identity === "auxiliary" && failure.correctness && failure.count >= 2) {
				this.signal = { workload: "investigation", risk: "high", safeToContinue: false,
					reason: "Repeated unresolved correctness failure; return evidence to Lead before further changes",
					evidence: `${key}\n${failure.evidence}` };
				this.explicitRisk = true;
				this.environmentalSignal = false;
			}
			if (this.failed.size > 8) this.failed.delete(this.failed.keys().next().value!);
		} else {
			this.failed.delete(key);
			if (["edit", "write", "ast_edit", "bash", "powershell"].includes(tool)) this.successfulActions++;
		}
	}

	/** An unsafe handoff blocks project effects, including arbitrary plugin/MCP tools. */
	allowsTool(tool: string): boolean {
		return this.signal.safeToContinue !== false || ["read", "grep", "find", "ls", "stat", "ast_grep",
			"semantic_search", "web_search", "web_fetch", "github", "question", "todo_write", "switch_mode",
			"task_cancel", "task_status", "fusion_route_model", "fusion_request_upgrade", "fusion_report", "fusion_review"].includes(tool);
	}

	initialRole(): FusionModelRole {
		return this.identity === "main" || this.signal.risk === "high" ||
			this.signal.workload === "planning" || this.signal.workload === "review" ? "lead" : "sidekick";
	}

	/** Only the caller's successful compaction hook may apply this recommendation. */
	atCacheBoundary(config: FusionConfig, currentModelKey: string): FusionRouteDecision | undefined {
		if (config.adaptiveRouting === false || config.leadModelKey === config.sidekickModelKey) return;
		// The controller owns decisions and acceptance. Cheap execution belongs in
		// its separate worker context, never by downgrading the controller itself.
		if (this.identity === "main") return currentModelKey === config.leadModelKey || this.failedRoutes.has("lead")
			? undefined : { role: "lead", reason: "Lead retains planning and acceptance responsibility" };
		const stalled = [...this.failed.values()].find((entry) => entry.correctness && entry.count >= 2);
		const needsLead = this.explicitRisk || this.signal.risk === "high" || (this.signal.safeToContinue === false && !this.environmentalSignal) ||
			this.signal.workload === "planning" || this.signal.workload === "review" || !!stalled;
		let decision: FusionRouteDecision | undefined;
		if (needsLead) decision = { role: "lead", reason: stalled
			? `Repeated unresolved correctness error: ${stalled.evidence}` : this.signal.reason };
		else if (this.switches < 2 && this.signal.workload === "routine" && this.signal.risk === "low" &&
			this.successfulActions > 0 && this.failed.size === 0 && this.environmentalFailures === 0)
			decision = { role: "sidekick", reason: "Bounded routine work with successful execution evidence and no unresolved errors" };
		if (!decision || this.failedRoutes.has(decision.role)) return;
		const key = decision.role === "lead" ? config.leadModelKey : config.sidekickModelKey;
		return currentModelKey === key ? undefined : decision;
	}

	recordAttempt(role: FusionModelRole, succeeded: boolean): void {
		if (succeeded) { this.switches++; this.successfulActions = 0; }
		else this.failedRoutes.add(role); // Auth/endpoint failures must not retry at every compaction.
	}

	snapshot() {
		return { identity: this.identity, workload: this.signal.workload, risk: this.signal.risk,
			safeToContinue: this.signal.safeToContinue !== false, reason: this.signal.reason,
			evidence: this.signal.evidence,
			successfulActions: this.successfulActions, unresolvedErrors: this.failed.size,
			environmentalFailures: this.environmentalFailures, environmentalSignal: this.environmentalSignal, switches: this.switches };
	}
}
