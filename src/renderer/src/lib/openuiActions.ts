import { createContext } from "react";
import type { ActionEvent } from "@openuidev/react-lang";
import type { SendPromptRequest } from "../../../shared/agent";
import type { TranslateFn } from "../i18n";

export type OpenUISend = (request: SendPromptRequest) => void | Promise<void>;
export const OpenUIActionsContext = createContext<{ send?: OpenUISend; disabled?: boolean }>({});

/** Includes the raw field state so values are never lost in a button label. */
export function openuiActionRequest(event: ActionEvent, t: TranslateFn): SendPromptRequest | null {
	if (event.type !== "continue_conversation" || !event.humanFriendlyMessage?.trim()) return null;
	const lines = [t("openui.actionMessage", { message: event.humanFriendlyMessage.trim() })];
	if (event.params && Object.keys(event.params).length) {
		lines.push(t("openui.actionContext"), JSON.stringify(event.params, null, 2));
	}
	if (event.formState && Object.keys(event.formState).length) {
		lines.push(t("openui.formValues"), JSON.stringify(event.formState, null, 2));
	}
	return { text: lines.join("\n") };
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
