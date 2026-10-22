import { createContext } from "react";
import type { ActionEvent } from "@openuidev/react-lang";
import type { SendPromptRequest } from "../../../shared/agent";
import { interactiveMessage } from "../../../shared/interactive-message";
import type { TranslateFn } from "../i18n";
import { openFileParams, openTaskParams, submitToAgentParams } from "./openuiActionDefinitions";

export type OpenUISend = (request: SendPromptRequest) => void | Promise<void>;
export interface OpenUIActionHandlers {
	send?: OpenUISend;
	openFile?: (path: string, line?: number) => void | Promise<void>;
	openTask?: (taskId: string) => void | Promise<void>;
	disabled?: boolean;
	storageScope?: string;
	readProjectJson?: (path: string) => Promise<unknown>;
}
export const OpenUIActionsContext = createContext<OpenUIActionHandlers>({});

export interface OpenUIHostScope {
	identity: object;
	active: boolean;
	disabled: boolean;
	cwd?: string;
	sessionId?: string;
	tasks?: readonly { id: string }[];
	onOpenFile?: (path: string) => void | Promise<void>;
	onOpenTask?: (id: string) => void | Promise<void>;
}

/** Resolve current host state at click time and again after asynchronous reads. */
export function createOpenUIHostActions(getScope: () => OpenUIHostScope, readFile: (cwd: string, path: string) => Promise<unknown>) {
	return {
		readProjectJson: async (path: string) => {
			const relative = openFileParams.shape.path.parse(path);
			const scope = getScope();
			if (!scope.active || !scope.cwd || !scope.sessionId || scope.disabled) throw new Error("Project data unavailable");
			const identity = scope.identity;
			const result = await readFile(scope.cwd, relative);
			const current = getScope();
			if (!current.active || current.identity !== identity || current.disabled) throw new Error("Session changed");
			if (!result || typeof result !== "object" || !("kind" in result) || result.kind !== "text" || !("text" in result) || typeof result.text !== "string" || ("truncated" in result && result.truncated)) throw new Error("A complete JSON text file is required");
			return JSON.parse(result.text);
		},
		openFile: async (path: string, line?: number) => {
			const scope = getScope();
			if (!scope.active || !scope.cwd || !scope.sessionId || scope.disabled || !scope.onOpenFile) throw new Error("File view unavailable");
			const identity = scope.identity;
			// Use the project-scoped host reader, not external-reference preview.
			await readFile(scope.cwd, path);
			const current = getScope();
			if (!current.active || current.identity !== identity || current.disabled || !current.onOpenFile) throw new Error("Session changed");
			await current.onOpenFile(line === undefined ? path : `${path}:${line}`);
		},
		openTask: async (taskId: string) => {
			const scope = getScope();
			if (!scope.active || scope.disabled || !scope.sessionId || !scope.tasks?.some(task => task.id === taskId) || !scope.onOpenTask) throw new Error("Task unavailable");
			await scope.onOpenTask(taskId);
		},
	};
}

/** Reject unknown capabilities and malformed parameters before touching the host. */
export async function dispatchOpenUIAction(event: ActionEvent, handlers: OpenUIActionHandlers, t: TranslateFn): Promise<void> {
	if (handlers.disabled) throw new Error("Session unavailable");
	if (event.type === "OpenFile") {
		const { path, line } = openFileParams.parse(event.params);
		if (!handlers.openFile) throw new Error("File view unavailable");
		await handlers.openFile(path, line);
		return;
	}
	if (event.type === "OpenTask") {
		const { taskId } = openTaskParams.parse(event.params);
		if (!handlers.openTask) throw new Error("Task view unavailable");
		await handlers.openTask(taskId);
		return;
	}
	if (event.type === "SubmitToAgent") {
		const { message, context } = submitToAgentParams.parse(event.params);
		event = { ...event, type: "continue_conversation", humanFriendlyMessage: message, params: context ? { context } : {} };
	}
	const request = openuiActionRequest(event, t);
	if (!request || !handlers.send) throw new Error("Unsupported action");
	await handlers.send(request);
}

/** Includes the raw field state so values are never lost in a button label. */
export function openuiActionRequest(event: ActionEvent, t: TranslateFn): SendPromptRequest | null {
	if (event.type !== "continue_conversation" || !event.humanFriendlyMessage?.trim()) return null;
	const message = t("openui.actionMessage", { message: event.humanFriendlyMessage.trim() });
	return { text: interactiveMessage(message, event.params, event.formState) };
}

/** Generated links must use the host's opener and cannot navigate Electron. */
export function openuiWebUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}
