import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface StoppedCommand {
	toolCallId: string;
	toolName: string;
	command: string;
}

/** Cancels one process without aborting the model run that must receive the user's reason. */
export class CommandExecutionControl {
	private readonly running = new Map<string, { controller: AbortController; stopped: boolean; executing: boolean }>();

	constructor(private readonly askReason: (command: StoppedCommand, signal?: AbortSignal) => Promise<string>) {}

	stop(toolCallId: string): boolean {
		const call = this.running.get(toolCallId);
		if (!call?.executing || call.stopped || call.controller.signal.aborted) return false;
		call.stopped = true;
		call.controller.abort();
		return true;
	}

	wrap(tool: ToolDefinition): ToolDefinition {
		return {
			...tool,
			execute: async (id, params, signal, onUpdate, context) => {
				if (signal?.aborted) throw new Error("aborted");
				const call = { controller: new AbortController(), stopped: false, executing: true };
				if (this.running.has(id)) throw new Error("Command is already running");
				this.running.set(id, call);
				const combined = signal ? AbortSignal.any([signal, call.controller.signal]) : call.controller.signal;
				let output = "";
				try {
					let result: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined;
					let failure: unknown;
					try {
						result = await tool.execute(id, params, combined, onUpdate, context);
						output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					} catch (error) {
						failure = error;
						output = error instanceof Error ? error.message : String(error);
					} finally {
						call.executing = false;
					}
					if (call.stopped && !signal?.aborted) {
						const command = (params as { command?: unknown })?.command;
						const reason = await this.askReason({ toolCallId: id, toolName: tool.name,
							command: typeof command === "string" ? command : "" }, signal);
						throw new Error(`Command stopped by user.\nUser's reason: ${reason}\nDo not rerun this command without explicit user approval. Cancellation is not approval.\n\n${output}`);
					}
					if (failure !== undefined) throw failure;
					if (!result) throw new Error("Command returned no result");
					return result;
				} finally {
					this.running.delete(id);
				}
			},
		};
	}
}
