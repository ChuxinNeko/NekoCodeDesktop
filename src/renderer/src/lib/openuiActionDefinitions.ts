import { defineAction } from "@openuidev/react-lang";
import { z } from "zod/v4";

// Shared by the generated prompt and the runtime dispatcher. These actions
// expose capabilities, never arbitrary IPC names or executable code.
export const openFileParams = z.object({
	path: z.string().trim().min(1).max(4096).refine(path => {
		const normalized = path.replace(/\\/g, "/");
		return !normalized.startsWith("/") && !/[\x00-\x1f\x7f:]/.test(normalized)
			&& !normalized.split("/").some(part => part === ".." || part === "");
	}, "Use a project-relative file path without traversal or a URL"),
	line: z.number().int().min(1).max(10_000_000).optional(),
}).strict();
export const openTaskParams = z.object({ taskId: z.string().trim().min(1).max(256) }).strict();
export const submitToAgentParams = z.object({
	message: z.string().trim().min(1).max(20_000),
	context: z.record(z.string(), z.json()).optional(),
}).strict();

export const openuiAppActions = [
	defineAction({ name: "OpenFile", description: "Open a project-relative file, optionally at a 1-based line. Use only paths seen in the conversation or tool results.", params: openFileParams }),
	defineAction({ name: "OpenTask", description: "Show an existing task belonging to this session. Use its actual task ID from tool results.", params: openTaskParams }),
	defineAction({ name: "SubmitToAgent", description: "Send a user message with optional structured context and submitted form fields to the current agent under its existing permissions.", params: submitToAgentParams }),
];
