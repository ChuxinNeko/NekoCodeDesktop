import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	FILE_MUTATION_ENTRY,
	MAX_PREIMAGE_BYTES,
	packPreimage,
	RECORDED_TOOLS,
	type FileMutationData,
} from "./file-journal";

/**
 * Records what a file looked like before the agent changed it.
 *
 * Hooks the same `beforeToolCall` / `afterToolCall` seam the work-mode gate uses,
 * because that is the one moment the old contents still exist and the tool has
 * already said which file it is about to touch. Reading one file there costs a
 * millisecond and is the entire price of being able to undo the turn — as
 * against mirroring the project, which costs the project.
 *
 * Both hooks chain rather than replace: pi installs its own for the extension
 * runner, and the workflow gate installs another on top.
 */
export class FileJournalRecorder {
	/** Pre-images read in `beforeToolCall`, waiting for their tool to finish. */
	private readonly pending = new Map<string, FileMutationData>();

	constructor(private readonly cwd: string) {}

	/**
	 * Resolve a tool's path argument, refusing anything outside the workspace.
	 *
	 * A path the agent chose is data, so it is checked rather than trusted: a
	 * mutation record naming somewhere outside the project would, on restore,
	 * write there.
	 */
	private workspacePath(value: unknown): { absolute: string; relative: string } | null {
		if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
		const root = resolve(this.cwd);
		const absolute = resolve(root, value);
		const suffix = relative(root, absolute);
		if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`)) return null;
		return { absolute, relative: suffix.split(sep).join("/") };
	}

	/** Read the pre-image for a tool that is about to change a file. */
	async beforeTool(toolCallId: string, toolName: string, args: unknown): Promise<void> {
		if (!RECORDED_TOOLS.includes(toolName)) return;
		const target = this.workspacePath((args as { path?: unknown } | null)?.path);
		if (!target) return;

		const record: FileMutationData = {
			path: target.relative,
			before: null,
			beforeBytes: 0,
			tool: toolName,
		};
		try {
			const info = await stat(target.absolute);
			if (!info.isFile()) return;
			if (info.size > MAX_PREIMAGE_BYTES) {
				// Noted rather than kept: an artifact this size in the transcript
				// would be paid for on every future open of the session.
				record.skipped = "too-large";
				record.beforeBytes = info.size;
			} else {
				const contents = await readFile(target.absolute);
				record.before = packPreimage(contents);
				record.beforeBytes = contents.length;
			}
		} catch (error) {
			// Absent is the common case and the interesting one: `before: null`
			// means the tool is creating the file, and undoing that is a delete.
			if ((error as { code?: string } | null)?.code !== "ENOENT") {
				record.skipped = "unreadable";
			}
		}
		this.pending.set(toolCallId, record);
	}

	/**
	 * Commit the pre-image once the tool has actually changed something.
	 *
	 * Dropped on failure: a tool that errored changed nothing, and a record
	 * claiming otherwise would make a restore rewrite a file with what is already
	 * in it — harmless, but it would also report a change that never happened.
	 */
	afterTool(session: AgentSession, toolCallId: string, isError: boolean): void {
		const record = this.pending.get(toolCallId);
		if (!record) return;
		this.pending.delete(toolCallId);
		if (isError) return;
		try {
			session.sessionManager.appendCustomEntry(FILE_MUTATION_ENTRY, record);
		} catch {
			// A transcript that will not take the record still ran the tool; losing
			// the undo is better than failing the turn over it.
		}
	}

	/** Forget pre-images for calls that never reported back (an aborted run). */
	reset(): void {
		this.pending.clear();
	}

	/**
	 * Chain the recorder onto a session's tool hooks.
	 *
	 * Called after the workflow gate has installed its own, so a tool the gate
	 * blocks is never recorded as having changed anything.
	 */
	attach(session: AgentSession): void {
		const previousBefore = session.agent.beforeToolCall;
		session.agent.beforeToolCall = async (context, signal) => {
			const result = await previousBefore?.(context, signal);
			// A blocked call changes nothing, so there is nothing to remember.
			if (result?.block) return result;
			try {
				await this.beforeTool(context.toolCall.id, context.toolCall.name, context.args);
			} catch (error) {
				// A throw here blocks the tool call, and pi turns a throw in
				// afterToolCall into a failed tool result. Losing the undo for one
				// call is a far smaller thing than failing the call over it.
				console.error("Could not record a pre-image:", error);
			}
			return result;
		};

		const previousAfter = session.agent.afterToolCall;
		session.agent.afterToolCall = async (context, signal) => {
			const result = await previousAfter?.(context, signal);
			try {
				this.afterTool(session, context.toolCall.id, result?.isError ?? context.isError);
			} catch (error) {
				console.error("Could not record a file change:", error);
			}
			return result;
		};
	}
}
