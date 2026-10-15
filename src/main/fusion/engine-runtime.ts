import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { FusionConfig } from "../../shared/fusion";
import { createInitialState, fusionReducer, type FusionState } from "../../shared/fusion-engine-state";
import { FusionEngine } from "./reference/core/fusion-engine";
import type { FusionMessage, FusionWorkerProfile } from "./reference/core/types";
import { PiFusionSessionStore } from "./pi-session-store";
import { PiFusionRunner } from "./pi-runner";
import { PiFusionStageDriver, type PiFusionStageHost } from "./pi-stage-driver";
import { FusionDelegateEngine } from "./delegate-engine";
import { FusionTeamEngine } from "./team-engine";
import { currentTeamSettings } from "../team-settings";
import { piAi } from "../pi";
import { liveTeamThreadTurn, settledTeamThreadTurn, TEAM_THREAD_ENTRY } from "../../shared/team-thread";

export const FUSION_ENGINE_TRACE_ENTRY = "nekocode.fusion.engine-trace.v1";

/** A desktop client of the unchanged shared engine; no delegation-tool orchestration. */
export class FusionEngineRuntime {
	state: FusionState = createInitialState();
	readonly driver: PiFusionStageDriver;
	private readonly store: PiFusionSessionStore;
	private controller?: AbortController;
	private pending?: Promise<void>;
	private closed = false;
	startedAt = 0;
	private fresh = false;
	private engine?: FusionEngine;
	/** Team members keep their context across turns, so the team engine outlives a run. */
	private team?: { engine: FusionTeamEngine; key: string };
	/** The team run's final answer once it is on the transcript, so the live group chat shows who sent it straight away. */
	teamFinal?: string;
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly nativePrompt: AgentSession["prompt"];
	private readonly nativeAbort: AgentSession["abort"];
	private readonly isNativeStreaming: () => boolean;
	constructor(private readonly host: PiFusionStageHost & { manager: SessionManager; config(): FusionConfig | null; cwd?: string;
		enabled(): boolean; instructions?: string; workerProfiles?: FusionWorkerProfile[] }) {
		const parent = host.parent;
		this.driver = new PiFusionStageDriver(host);
		this.store = new PiFusionSessionStore(host.manager);
		this.nativePrompt = parent.prompt.bind(parent); this.nativeAbort = parent.abort.bind(parent);
		this.isNativeStreaming = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(parent), "isStreaming")?.get?.bind(parent) ?? (() => false);
		const nativeSubscribe = parent.subscribe.bind(parent);
		parent.subscribe = (listener) => {
			this.listeners.add(listener);
			const detach = nativeSubscribe(event => {
				// The engine is one user turn even though Main executes and then synthesizes.
				if (this.running && ["agent_start", "agent_end"].includes(event.type)) return;
				listener(event);
			});
			return () => { this.listeners.delete(listener); detach(); };
		};
		Object.defineProperty(parent, "isStreaming", { configurable: true, get: () =>
			this.running && !this.driver.nativeMainActive ? true : this.isNativeStreaming() });
		// Keep native isIdle: PI uses it to release its own abort/settle waiters.
		// The full coordinated run is represented by isStreaming and this.running.
		parent.prompt = async (text, options) => {
			if (!host.enabled()) return this.nativePrompt(text, options);
			if (this.running) throw new Error("Fusion is already running; stop the current run before sending a new task");
			this.pending = this.run(text, options);
			try { await this.pending; } finally { this.pending = undefined; }
		};
		parent.abort = async () => { this.controller?.abort(new Error("Fusion cancelled"));
			await Promise.all([this.nativeAbort(), this.driver.abort()]); };
	}
	get running(): boolean { return !!this.controller; }
	reset(): void { this.fresh = true; this.engine = undefined; this.dropTeam(); this.state = createInitialState(); }
	private dropTeam(): void { this.team?.engine.dispose(); this.team = undefined; }
	stop(): void { this.controller?.abort(new Error("Fusion cancelled")); void this.driver.abort(); }
	dispose(): void { this.closed = true; this.stop(); this.dropTeam(); }
	async whenSettled(): Promise<void> { await this.pending?.catch(() => undefined); }
	private async run(prompt: string, options?: Parameters<AgentSession["prompt"]>[1]): Promise<void> {
		if (this.closed) throw new Error("Fusion runtime disposed");
		const config = this.host.config();
		if (!config) throw new Error("Fusion is not configured");
		const nativeSettings = this.host.parent.settingsManager;
		const compaction = nativeSettings.getCompactionSettings().enabled;
		const warming = nativeSettings.getCacheWarmingMode();
		this.controller = new AbortController();
		const controller = this.controller;
		try {
			this.startedAt = Date.now(); this.teamFinal = undefined;
			const priorMessages = [...this.host.parent.messages];
			this.driver.begin(prompt);
			this.state = fusionReducer(this.state, { type: "run.submitted", prompt });
			this.emit({ type: "agent_start" }); this.host.onChange();
			// Record the actual user once, before planning. All model stages use the engine's lane contexts.
			const user = { role: "user" as const, content: options?.images?.length ?
				[{ type: "text" as const, text: prompt }, ...options.images] : prompt, timestamp: this.startedAt };
			this.host.manager.appendMessage(user);
			this.host.parent.agent.state.messages = [...this.host.parent.agent.state.messages, user];
			this.emit({ type: "message_start", message: user }); this.emit({ type: "message_end", message: user });
			const strategy = config.strategy ?? "delegate";
			const delegate = strategy === "delegate";
			if (strategy !== "team") this.dropTeam();
			const engine = strategy === "team" ? this.teamEngine(config) : delegate ? new FusionDelegateEngine({ run: request => this.driver.run(request), release: handle => this.driver.release(handle),
				appendFinal: text => this.appendLeadMessage(text, config.leadModelKey), store: this.store, cwd: this.host.cwd ?? process.cwd(),
				models: { main: config.leadModelKey, sidekick: config.sidekickModelKey }, ...(this.host.instructions ? { instructions: this.host.instructions } : {}),
				...(config.contextMessageLimit ? { contextMessageLimit: config.contextMessageLimit } : {}) }) : this.engine ??= new FusionEngine({ runner: new PiFusionRunner(request => this.driver.run(request), this.host.instructions),
				store: this.store, contextMessageLimit: config.contextMessageLimit,
				models: { main: [config.leadModelKey], sidekick: config.adaptiveRouting === false ? [config.sidekickModelKey] : [config.sidekickModelKey, config.leadModelKey] } });
			const saved = this.fresh ? undefined : this.store.latest();
			this.fresh = false;
			const prior: FusionMessage[] = saved ? [] : priorMessages.flatMap(message =>
				message.role === "user" || message.role === "assistant" ? [{ role: message.role,
					content: typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n") }] : []);
			this.host.parent.setAutoCompactionEnabled(false); this.host.parent.setCacheWarmingMode("off");
			let failure: string | undefined;
			for await (const event of engine.stream({ prompt, signal: this.controller.signal,
				...(saved ? { sessionId: saved.id } : { messages: prior }),
				...(config.budget ? { budget: config.budget } : {}),
				...(config.workerProfiles ?? this.host.workerProfiles ? { workerProfiles: config.workerProfiles ?? this.host.workerProfiles } : {}) })) {
				this.state = fusionReducer(this.state, { type: "event.received", event });
				if (event.type === "session.failed") failure = event.message;
				this.host.onChange();
			}
			if (failure) throw new Error(failure);
			if (this.controller.signal.aborted) throw this.controller.signal.reason;
			if (this.state.status !== "complete") throw new Error("Fusion ended without authoritative synthesis");
		} finally {
			controller.abort();
			try { await this.driver.abort(); }
			finally {
				this.controller = undefined;
				try {
					// The team's group chat is saved on its own, small, so it can be shown again when the chat is reopened.
					const team = liveTeamThreadTurn(this.state, this.startedAt, this.teamFinal);
					if (team) this.host.manager.appendCustomEntry(TEAM_THREAD_ENTRY, settledTeamThreadTurn(team));
					this.host.manager.appendCustomEntry(FUSION_ENGINE_TRACE_ENTRY, this.state);
				}
				finally {
					this.host.parent.setAutoCompactionEnabled(compaction); this.host.parent.setCacheWarmingMode(warming);
					this.emit({ type: "agent_end", messages: this.host.parent.messages, willRetry: false }); this.host.onChange();
				}
			}
		}
	}
	private teamEngine(config: FusionConfig): FusionTeamEngine {
		const key = JSON.stringify([config.leadModelKey, config.contextMessageLimit]);
		if (this.team?.key === key) return this.team.engine;
		this.dropTeam();
		const engine = new FusionTeamEngine({ run: request => this.driver.run(request), release: handle => this.driver.release(handle),
			appendFinal: (text, modelKey) => { this.teamFinal = text; return this.appendLeadMessage(text, modelKey); }, store: this.store,
			team: () => currentTeamSettings(), defaultModelKey: config.leadModelKey,
			...(this.host.instructions ? { instructions: this.host.instructions } : {}),
			...(config.contextMessageLimit ? { contextMessageLimit: config.contextMessageLimit } : {}) });
		this.team = { engine, key };
		return engine;
	}
	/** Delegate reviews run in a side actor; put Lead's accepted answer on the parent transcript. */
	private async appendLeadMessage(text: string, modelKey: string): Promise<void> {
		const { fauxAssistantMessage } = await piAi();
		const model = this.host.resolveModel(modelKey);
		const message = { ...fauxAssistantMessage(text), provider: model.provider, model: model.id, api: model.api };
		this.host.manager.appendMessage(message);
		this.host.parent.agent.state.messages = [...this.host.parent.agent.state.messages, message];
		this.emit({ type: "message_start", message }); this.emit({ type: "message_end", message });
	}
	private emit(event: AgentSessionEvent): void { for (const listener of this.listeners) listener(event); }
}
