import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SendPromptRequest } from "../../../../shared/agent";
import { useTranslation } from "../../i18n";
import { copyText } from "../../lib/clipboard";
import { dispatchSelectionAction, type SelectionRequestAction } from "../../lib/selectionPrompt";
import { SelectionExplanation } from "./SelectionExplanation";
import SelectionActions from "../primitives/SelectionActions";

export type SelectionSend = (request: SendPromptRequest) => void | Promise<void>;

/** Only explicitly marked, settled assistant Markdown can own a selection. */
export function AssistantSelection({ children, onSend, modelKey }: { children: ReactNode; onSend?: SelectionSend; modelKey?: string | null }) {
  const { t } = useTranslation();
  const [explanation, setExplanation] = useState<string | null>(null);
  const scope = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const selecting = useRef(false);
  const [picked, setPicked] = useState<{ range: Range; text: string; body: Element; pointerOffsetX?: number } | null>(null);

  useEffect(() => {
    if (explanation !== null) { setPicked(null); return; }
    if (!onSend) { setPicked(null); return; }
    const close = () => setPicked(null);
    const update = (event?: Event) => {
      if (selecting.current || (event?.target instanceof Node && toolbar.current?.contains(event.target))) return;
      // Focusing the instruction field may collapse the browser's selection.
      // Retain the captured range while interacting with its toolbar.
      if (toolbar.current?.contains(document.activeElement)) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !selection.toString().trim()) { close(); return; }
      const range = selection.getRangeAt(0);
      const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
      const body = element?.closest('[data-assistant-selection-body="true"]');
      if (!body || !scope.current?.contains(body) || !body.contains(range.endContainer)) { close(); return; }
      setPicked(current => ({
        range: range.cloneRange(), text: selection.toString(), body,
        pointerOffsetX: event instanceof PointerEvent
          ? event.clientX - range.getBoundingClientRect().left
          : current?.range.startContainer === range.startContainer && current.range.startOffset === range.startOffset &&
            current.range.endContainer === range.endContainer && current.range.endOffset === range.endOffset
            ? current.pointerOffsetX : undefined,
      }));
    };
    const pointer = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) {
        selecting.current = true;
        close();
      }
    };
    const release = (event: PointerEvent) => { selecting.current = false; update(event); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    // A cell becoming streaming, or a folded/unmounted body, invalidates it.
    const observer = new MutationObserver(() => {
      setPicked(current => current && (!current.body.isConnected || current.body.getAttribute("data-assistant-selection-body") !== "true") ? null : current);
    });
    if (scope.current) observer.observe(scope.current, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-assistant-selection-body"] });
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", release);
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [onSend, explanation]);

  return <div ref={scope}>
    {children}
    {explanation !== null ? <SelectionExplanation original={explanation} modelKey={modelKey} onClose={() => {
      window.getSelection()?.removeAllRanges();
      setExplanation(null);
    }} /> : null}
    {picked && onSend ? createPortal(
      <div ref={toolbar} className="beautiful-selection-actions fixed inset-x-0 top-0 z-50"
        onPointerDown={event => {
          if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
        }}>
        <SelectionActions key={picked.text + picked.range.startOffset + ":" + picked.range.endOffset}
          range={picked.range}
          pointerOffsetX={picked.pointerOffsetX}
          actionLabels={{ explain: t("selection.explain"), improve: t("selection.improve"), shorten: t("selection.shorten"), tone: t("selection.tone"), grammar: t("selection.grammar") }}
          labels={{ keep: t("selection.keep"), discard: t("selection.discard"), placeholder: t("selection.placeholder"), retry: t("selection.retry"), more: t("selection.more"), fewer: t("selection.fewer"), send: t("selection.send"), editing: t("selection.thinking"), copy: t("selection.copy"), error: t("selection.error") }}
          onCopy={async () => { await copyText(picked.text); setPicked(null); }}
          onAction={async (action, custom) => {
            await dispatchSelectionAction(picked.text, custom ? { custom: action } : { action: action as SelectionRequestAction }, t, { explain: setExplanation, send: onSend });
            setPicked(null);
          }}
        />
      </div>, document.body,
    ) : null}
  </div>;
}
