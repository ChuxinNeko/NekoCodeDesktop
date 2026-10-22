import { z } from "zod/v4";
import type { ToolSpec } from "@openuidev/react-lang";
import { openFileParams } from "./openuiActionDefinitions";

const collection = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
export const openuiToolSchemas = {
	app_list: z.object({ collection }).strict(),
	app_save: z.object({ collection, record: z.record(z.string(), z.json()) }).strict(),
	app_delete: z.object({ collection, id: z.string().min(1).max(256) }).strict(),
	project_read_json: z.object({ path: openFileParams.shape.path }).strict(),
};
export const OPENUI_WRITE_TOOLS = new Set(["app_save", "app_delete"]);

const descriptions: Record<keyof typeof openuiToolSchemas, string> = {
	app_list: "Read this application's locally saved records. Returns {rows: [{id, ...fields}], total}. Collections start empty. Use Query; no network or model call.",
	app_save: "Create/update a record in this application's local collection. Omit record.id to create; preserve its id to update. Returns {row}. Use Mutation and @Run on an explicit user click, then refresh the app_list query. Does not edit project files.",
	app_delete: "Delete one record by id from this application's local collection. Returns {deleted}. Use Mutation and an explicit delete button, then refresh the app_list query. Does not edit project files.",
	project_read_json: "Read an existing project-relative JSON file as {data}. Use only paths confirmed by the user or tool results. Read-only; available only when the host supplies project access. No arbitrary network, commands or file writes.",
};

export const openuiTools: ToolSpec[] = (Object.keys(openuiToolSchemas) as Array<keyof typeof openuiToolSchemas>).map(name => ({
	name,
	description: descriptions[name],
	inputSchema: z.toJSONSchema(openuiToolSchemas[name]),
	outputSchema: { type: "object", additionalProperties: true },
	annotations: { readOnlyHint: !OPENUI_WRITE_TOOLS.has(name), destructiveHint: name === "app_delete" },
}));
