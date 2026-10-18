import type { SendPromptRequest } from "../../../shared/agent";
import type { TranslateFn } from "../i18n";

export type SelectionRequestAction = "explain" | "improve" | "shorten" | "tone" | "grammar";

/** Build a new turn, keeping the quoted passage distinct from the instruction. */
export function selectionPrompt(
  selected: string,
  instruction: { action: SelectionRequestAction } | { custom: string },
  t: TranslateFn,
): SendPromptRequest {
  const original = selected.trim();
  const task = "custom" in instruction ? instruction.custom.trim() : t(`selection.request.${instruction.action}`);
  if (!original || !task) throw new Error("Selection and instruction must be nonempty");
  return { text: t("selection.request.template", { original, instruction: task }) };
}

/** Explain opens the isolated side chat; every other instruction keeps its sender. */
export async function dispatchSelectionAction(
  selected: string,
  instruction: { action: SelectionRequestAction } | { custom: string },
  t: TranslateFn,
  handlers: {
    explain: (original: string) => void;
    send: (request: SendPromptRequest) => void | Promise<void>;
  },
): Promise<void> {
  if ("action" in instruction && instruction.action === "explain") {
    handlers.explain(selected);
    return;
  }
  await handlers.send(selectionPrompt(selected, instruction, t));
}
