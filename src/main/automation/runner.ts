import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Automation } from "../../shared/automation";
import { pi } from "../pi";
import { createPromptResources } from "../workflow-runtime";
import { createStatTool } from "../file-tools";
import { COMPACTION_INSTRUCTIONS, toolsForMode, type PromptContext } from "../prompt-library";

const SUMMARY_LIMIT = 2_000;
const RUN_TIMEOUT_MS = 30 * 60_000;

export interface AutomationRunOutcome {
	summary: string;
	toolCalls: number;
	sessionFile?: string;
	aborted: boolean;
	/** Set when the run ended in an error rather than a stop. */
	failure?: string;
}

export interface AutomationRunnerOptions {
	/** Where JSONL session transcripts live; shared with the interactive agent. */
	sessionsDir: string;
	/** The single runtime instance, so custom providers are registered once. */
	getModelRuntime: () => Promise<ModelRuntime>;
}

/**
 * Runs one automation prompt in a headless PI session.
 *
 * The run gets its own `SessionManager` and `AgentSession` so it never touches the
 * window's interactive session. It shares the app's `ModelRuntime` because provider
 * registration is global; constructing a second runtime would duplicate provider
 * registrations and credentials.
 */
export class AutomationRunner {
	private readonly options: AutomationRunnerOptions;

	constructor(options: AutomationRunnerOptions) {
		this.options = options;
	}

	async run(automation: Automation, externalSignal: AbortSignal): Promise<AutomationRunOutcome> {
		const { createAgentSession, SessionManager } = await pi();
		const modelRuntime = await this.options.getModelRuntime();
		const sessionManager = SessionManager.create(automation.cwd, this.options.sessionsDir);
		let currentSession: AgentSession | undefined;
		const context = (): PromptContext => ({
			mode: "agent",
			permission: automation.mode,
			headless: true,
			modelId: currentSession?.model
				? currentSession.model.provider + "/" + currentSession.model.id
				: (automation.modelKey ?? undefined),
		});
		const resourceLoader = await createPromptResources(automation.cwd, context);
		const { session } = await createAgentSession({
			resourceLoader,
			tools: toolsForMode(context()),
			customTools: [createStatTool(automation.cwd)],
			compactionInstructions: COMPACTION_INSTRUCTIONS,
			cwd: automation.cwd,
			sessionManager,
			modelRuntime,
		});

		currentSession = session;

		// PI's session owns cancellation; a local AbortController would stop nothing.
		// Both the caller's signal and the wall-clock ceiling funnel into session.abort().
		let aborted = false;
		const requestAbort = () => {
			aborted = true;
			void session.abort();
		};
		const timeout = setTimeout(requestAbort, RUN_TIMEOUT_MS);
		if (externalSignal.aborted) requestAbort();
		externalSignal.addEventListener("abort", requestAbort, { once: true });

		let toolCalls = 0;
		let lastError: string | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") toolCalls += 1;
			if (event.type === "auto_retry_end" && !event.success) {
				lastError = event.finalError ?? "retry failed";
			}
		});

		let failure: string | undefined;
		try {
			await this.applyModel(session, modelRuntime, automation);
			session.setSessionName(automation.name.slice(0, 80));
			session.setActiveToolsByName(toolsForMode(context()));
			if (!aborted) await session.prompt(automation.prompt);
		} catch (error) {
			// An abort surfaces as a rejected prompt; that is a normal stop, not a failure.
			if (!aborted) failure = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timeout);
			externalSignal.removeEventListener("abort", requestAbort);
			unsubscribe();
		}

		const messages = session.messages;
		const summary = lastAssistantText(messages) || lastError || failure || "";
		const sessionFile = sessionManager.getSessionFile() ?? undefined;
		session.dispose();
		return {
			summary: summary.slice(0, SUMMARY_LIMIT),
			toolCalls,
			...(sessionFile === undefined ? {} : { sessionFile }),
			aborted,
			...(failure === undefined ? {} : { failure }),
		};
	}

	/** Select the automation's pinned model when it is still registered. */
	private async applyModel(
		session: AgentSession,
		runtime: ModelRuntime,
		automation: Automation,
	): Promise<void> {
		const key = automation.modelKey;
		if (!key) return;
		const separator = key.indexOf("/");
		if (separator <= 0) return;
		const model = runtime.getModel(key.slice(0, separator), key.slice(separator + 1));
		if (model) await session.setModel(model);
	}
}

function lastAssistantText(messages: readonly { role: string; content?: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content.trim();
		if (!Array.isArray(content)) continue;
		const text = content
			.flatMap((block) =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
					? [(block as { text: string }).text]
					: [],
			)
			.join("")
			.trim();
		if (text.length > 0) return text;
	}
	return "";
}
