import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MAX_MEMORY_TEXT } from "../shared/memory";
import type { MemoryStore } from "./memory-store";

export const MEMORY_TOOL_NAME = "memory";

const memorySchema = Type.Object(
	{
		action: Type.Union([Type.Literal("save"), Type.Literal("delete"), Type.Literal("list")], {
			description: "save a new memory, delete one by id, or list what is remembered.",
		}),
		scope: Type.Optional(
			Type.Union([Type.Literal("user"), Type.Literal("project")], {
				description: "save only. user = the user's preference in every project; project = a convention of this codebase. Defaults to project.",
			}),
		),
		text: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_MEMORY_TEXT, description: "save only. One self-contained fact, written so it still makes sense in a future session." }),
		),
		id: Type.Optional(Type.String({ minLength: 4, maxLength: 64, description: "delete only. The id shown in brackets in the memory list." })),
	},
	{ additionalProperties: false },
);

/**
 * The agent's handle on long-term memory.
 *
 * Writes go to the app's data directory, never the project, so this is safe
 * in read-only sessions — remembering how the user likes to work is not a
 * change to their code.
 */
export function createMemoryTool(cwd: string, store: MemoryStore): ToolDefinition {
	return {
		name: MEMORY_TOOL_NAME,
		label: MEMORY_TOOL_NAME,
		description:
			"Long-term memory that persists across sessions. Save a fact when the user states a lasting preference or project convention, explicitly asks you to remember something, or corrects you in a way that should stick. Do not save secrets, credentials, one-off task details, or anything already in AGENTS.md. Delete memories that turn out to be wrong or outdated.",
		promptSnippet:
			"memory(action=save|delete|list) keeps cross-session user preferences (scope=user) and project conventions (scope=project); current memories are already in the system prompt.",
		parameters: memorySchema,
		async execute(_id, params) {
			const input = params as Static<typeof memorySchema>;
			if (input.action === "list") {
				const entries = store.forProject(cwd);
				const text = entries.length
					? entries.map((entry) => `[${entry.id.slice(0, 8)}] (${entry.scope}) ${entry.text}`).join("\n")
					: "No memories saved.";
				return { content: [{ type: "text", text }], details: { count: entries.length } };
			}
			if (input.action === "save") {
				if (!input.text?.trim()) throw new Error("text is required to save a memory");
				const entry = store.save({ scope: input.scope ?? "project", cwd, text: input.text }, "agent");
				return {
					content: [{ type: "text", text: `Saved memory [${entry.id.slice(0, 8)}] (${entry.scope}).` }],
					details: { id: entry.id, scope: entry.scope },
				};
			}
			const wanted = input.id?.trim().replace(/^\[|\]$/g, "");
			if (!wanted) throw new Error("id is required to delete a memory");
			const matches = store.forProject(cwd).filter((entry) => entry.id.startsWith(wanted));
			if (matches.length === 0) throw new Error(`No memory with id ${wanted}`);
			if (matches.length > 1) throw new Error(`Id ${wanted} is ambiguous; use more characters`);
			store.remove(matches[0].id);
			return {
				content: [{ type: "text", text: `Deleted memory [${wanted}].` }],
				details: { id: matches[0].id },
			};
		},
	};
}
