import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel, TurnUsage } from "../../shared/agent";
import { textOf } from "../agent-projection";
import { piAi } from "../pi";
import { FUSION_PLAN_SCHEMA, type PiFusionActorHandle, type PiFusionStage, type PiFusionStageResult } from "./pi-runner";

export interface PiFusionStageHost {
	parent: AgentSession;
	createActor(request: PiFusionStage): Promise<AgentSession>;
	resolveModel(key: string): Model<Api>;
	thinking(role: "main" | "sidekick"): ThinkingLevel;
	allowedTools(role: "main" | "sidekick"): string[];
	onUsage(request: PiFusionStage, usage: TurnUsage, source: string): void;
	onActorEvent?(event: AgentSessionEvent, sessionId: string): void;
	onChange(): void;
}

/** PI runs tools and streams; the unchanged reference engine owns all orchestration. */
export class PiFusionStageDriver {
	currentMainStage?: PiFusionStage;
	nativeMainActive = false;
	private actors = new Set<AgentSession>();
	private originalTask = "";
	constructor(private readonly host: PiFusionStageHost) {}
	begin(task: string): void { this.originalTask = task; }
	// The runtime cancels the parent through its captured native abort method.
	// Calling the wrapped parent.abort here would recursively call this method.
	/** Dispose an actor kept alive across stages. */
	release(handle: PiFusionActorHandle): void { handle.session?.dispose(); handle.session = undefined; handle.transform = undefined; }
	async abort(): Promise<void> { await Promise.all([...this.actors].filter(session => session !== this.host.parent).map(session => session.abort())); }
	async run(request: PiFusionStage): Promise<PiFusionStageResult> {
		if (request.signal?.aborted) throw request.signal.reason ?? new Error("Fusion cancelled");
		if (typeof request.model !== "string") throw new Error("PI Fusion requires a configured provider/model key");
		const main = request.role === "main" && ["execute", "synthesize"].includes(request.kind);
		const reused = !main && !!request.actor?.session;
		const session = main ? this.host.parent : request.actor?.session ?? await this.host.createActor(request);
		if (request.actor) request.actor.session = session;
		this.actors.add(session);
		const previousTransform = session.agent.transformContext;
		const previousFinish = session.agent.finishTurn;
		let unsubscribe = () => {};
		const abort = () => { void session.abort(); };
		try {
			if (request.signal?.aborted) throw request.signal.reason ?? new Error("Fusion cancelled");
			if (main) { this.currentMainStage = request; this.nativeMainActive = true; }
			const model = this.host.resolveModel(request.model);
			const baseline = session.agent.state.messages.filter(message => message.role !== "system").length;
			const startMessageIndex = session.messages.length;
			let steps = 0, plan: unknown, submitted: unknown;
			let toolFailure: string | undefined;
			const { fauxAssistantMessage, getCurrentTools } = await piAi();
			const seed: AgentMessage[] = request.messages.filter(message => message.role !== "system").map(message =>
				message.role === "assistant" ? { ...fauxAssistantMessage(message.content), provider: model.provider, model: model.id, api: model.api } :
					{ role: "user", content: message.content, timestamp: Date.now() });
			// A reused actor keeps its first-stage transform: the new prompt is part of its tail.
			if (reused && request.actor?.transform) session.agent.transformContext = request.actor.transform;
			else session.agent.transformContext = async (messages) => {
				const system = [...messages].reverse().find(message => message.role === "system");
				const tail = messages.filter(message => message.role !== "system").slice(baseline);
				// The canonical user/custom stage message is represented by the final seed message.
				if (tail[0]?.role === "user" || tail[0]?.role === "custom") tail.shift();
				return [{ ...(system ?? { role: "system" as const, timestamp: Date.now() }),
					toolsAdded: getCurrentTools(messages), toolsRemoved: undefined,
					content: [request.instructions, ...request.messages.filter(message => message.role === "system").map(message => message.content)].join("\n\n") },
					...seed, ...tail];
			};
			if (request.actor && !reused) request.actor.transform = session.agent.transformContext;
			let finalNotice = false;
			if (request.finalStepTools) {
				const base = session.agent.transformContext;
				session.agent.transformContext = async (messages, signal) => {
					const out = await base!(messages, signal);
					return finalNotice ? [...out, { role: "user" as const, timestamp: Date.now(), content: request.submitTool ?
						`Step budget reached. Call ${request.submitTool.name} now with your best judgment.` :
						"Step budget reached. Stop using tools and give your final report now, listing anything left unfinished." }] : out;
				};
			}
			const maxSteps = request.maxSteps ?? (request.kind === "plan" || request.kind === "compact" ? 1 : 20);
			session.agent.finishTurn = async () => {
				steps++;
				if (request.kind === "plan" && plan !== undefined) return { action: "end" };
				if (submitted !== undefined) return { action: "end" };
				if (steps >= maxSteps) return { action: "end" };
				if (request.finalStepTools && steps === maxSteps - 1) {
					finalNotice = true;
					const allowed = this.host.allowedTools(request.role).filter(name => request.finalStepTools!.includes(name));
					session.setActiveToolsByName([...allowed, ...(request.submitTool ? [request.submitTool.name] : [])]);
				}
			};
			if (request.kind === "plan") {
				const submit: ToolDefinition = { name: "fusion_submit_plan", label: "Fusion plan", description: "Return the typed Fusion plan. Do not execute it.",
					parameters: FUSION_PLAN_SCHEMA, execute: async (_id, args) => { plan = structuredClone(args);
						return { content: [{ type: "text", text: "Plan recorded" }], details: args }; } };
				session.setCustomTools([submit]); session.setActiveToolsByName([submit.name]);
			} else if (request.submitTool || request.extraTools?.length) {
				const spec = request.submitTool;
				const submit: ToolDefinition | undefined = spec && { name: spec.name, label: spec.name, description: spec.description,
					parameters: spec.parameters as ToolDefinition["parameters"], execute: async (_id, args) => { submitted = structuredClone(args);
						return { content: [{ type: "text", text: "Recorded" }], details: args }; } };
				const added = [...(request.extraTools ?? []), ...(submit ? [submit] : [])];
				const addedNames = new Set(added.map(tool => tool.name));
				const existing = session.getAllTools().flatMap(info => {
					const definition = addedNames.has(info.name) ? undefined : session.getToolDefinition(info.name);
					return definition ? [definition] : [];
				});
				session.setCustomTools([...existing, ...added]);
				const allowed = this.host.allowedTools(request.role);
				// A submit stage only gets the tools it names; a plain extra-tool stage keeps the role's tools.
				const base = request.activeTools ? allowed.filter(name => request.activeTools!.includes(name)) : submit ? [] : allowed;
				session.setActiveToolsByName([...base, ...addedNames]);
			} else {
				const allowed = this.host.allowedTools(request.role);
				session.setActiveToolsByName(request.kind === "compact" ? [] :
					request.activeTools ? allowed.filter(name => request.activeTools!.includes(name)) : allowed);
			}
			const usage = { inputTokens: 0, outputTokens: 0 };
			const toolStarts = new Map<string, number>();
			let sequence = 0;
			unsubscribe = session.subscribe(event => {
				if (!main) this.host.onActorEvent?.(event, session.sessionId);
				if (event.type === "message_update") {
					const part = event.assistantMessageEvent;
					if (part.type === "text_delta") request.onStreamPart?.({ type: "text-delta", text: part.delta });
					if (part.type === "thinking_delta") request.onStreamPart?.({ type: "reasoning-delta", text: part.delta });
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					const value = event.message.usage;
					usage.inputTokens += value.input + value.cacheRead + value.cacheWrite; usage.outputTokens += value.output;
					this.host.onUsage(request, { provider: event.message.provider, model: event.message.model, calls: 1,
						input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, totalTokens: value.totalTokens,
						...(value.cost?.total !== undefined ? { costUsd: value.cost.total } : {}) }, `${session.sessionId}:${++sequence}:${event.message.timestamp}`);
				}
				if (event.type === "tool_execution_start") {
					toolStarts.set(event.toolCallId, Date.now()); request.onToolEvent?.({ type: "started", toolCallId: event.toolCallId,
						toolName: event.toolName, input: event.args });
				}
				if (event.type === "tool_execution_end") {
					if (event.isError) toolFailure = textOf(event.result.content);
					const durationMs = Date.now() - (toolStarts.get(event.toolCallId) ?? Date.now());
					request.onToolEvent?.(event.isError ? { type: "failed", toolCallId: event.toolCallId, toolName: event.toolName,
						durationMs, error: textOf(event.result.content) } : { type: "completed", toolCallId: event.toolCallId,
						toolName: event.toolName, durationMs, output: event.result });
				}
			});
			request.signal?.addEventListener("abort", abort, { once: true });
			await session.setModel(model); session.setThinkingLevel(request.thinkingLevel ?? this.host.thinking(request.role));
			if (request.signal?.aborted) throw request.signal.reason ?? new Error("Fusion cancelled");
			if (main && request.kind === "execute") await session.sendCustomMessage({ customType: "nekocode.fusion.main-task.v1",
				content: request.messages.at(-1)?.content ?? this.originalTask, display: false }, { triggerTurn: true });
			else if (main) await session.sendCustomMessage({ customType: "nekocode.fusion.synthesis.v1",
				content: request.messages.at(-1)?.content ?? "Synthesize results", display: false }, { triggerTurn: true });
			else await session.prompt(request.messages.at(-1)?.role === "user" ? request.messages.at(-1)!.content : "Continue", { expandPromptTemplates: false });
			if (request.signal?.aborted) throw request.signal.reason ?? new Error("Fusion cancelled");
			const last = session.messages.slice(startMessageIndex).filter(message => message.role === "assistant").at(-1);
			if (last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason)) throw new Error(last.errorMessage ?? `Fusion ${request.role} failed`);
			if (request.kind === "plan" && plan === undefined && toolFailure) throw new Error(toolFailure);
			return { text: last ? textOf(last.content) : "", usage, ...(plan === undefined ? {} : { plan }),
				...(submitted === undefined ? {} : { submitted }), steps };
		} finally {
			request.signal?.removeEventListener("abort", abort); unsubscribe();
			this.actors.delete(session);
			if (!request.actor) { session.agent.transformContext = previousTransform; session.agent.finishTurn = previousFinish; }
			if (!main && !request.actor) session.dispose();
			else { this.currentMainStage = undefined; this.nativeMainActive = false; this.host.onChange(); }
		}
	}
}
