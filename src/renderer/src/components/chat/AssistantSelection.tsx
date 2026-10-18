import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SendPromptRequest } from "../../../../shared/agent";
import { useTranslation } from "../../i18n";
import { copyText } from "../../lib/clipboard";
import { selectionPrompt, type SelectionRequestAction } from "../../lib/selectionPrompt";
import SelectionActions from "../primitives/SelectionActions";

export type SelectionSend = (request: SendPromptRequest) => void | Promise<void>;

/** Only explicitly marked, settled assistant Markdown can own a selection. */
export function AssistantSelection({ children, onSend }: { children: ReactNode; onSend?: SelectionSend }) {
  const { t } = useTranslation();
  const scope = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{ range: Range; text: string; body: Element } | null>(null);

  useEffect(() => {
    if (!onSend) { setPicked(null); return; }
    const close = () => setPicked(null);
    const update = () => {
      // Focusing the instruction field may collapse the browser's selection.
      // Retain the captured range while interacting with its toolbar.
      if (toolbar.current?.contains(document.activeElement)) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !selection.toString().trim()) { close(); return; }
      const range = selection.getRangeAt(0);
      const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
      const body = element?.closest('[data-assistant-selection-body="true"]');
      if (!body || !scope.current?.contains(body) || !body.contains(range.endContainer)) { close(); return; }
      setPicked({ range: range.cloneRange(), text: selection.toString(), body });
    };
    const pointer = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    // A cell becoming streaming, or a folded/unmounted body, invalidates it.
    const observer = new MutationObserver(() => {
      setPicked(current => current && (!current.body.isConnected || current.body.getAttribute("data-assistant-selection-body") !== "true") ? null : current);
    });
    if (scope.current) observer.observe(scope.current, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-assistant-selection-body"] });
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", update);
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", update);
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [onSend]);

  return <div ref={scope}>
    {children}
    {picked && onSend ? createPortal(
      <div ref={toolbar} className="beautiful-selection-actions fixed inset-x-0 top-0 z-50"
        onPointerDown={event => {
          if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
        }}>
        <SelectionActions key={picked.text + picked.range.startOffset + ":" + picked.range.endOffset}
          range={picked.range}
          actionLabels={{ explain: t("selection.explain"), improve: t("selection.improve"), shorten: t("selection.shorten"), tone: t("selection.tone"), grammar: t("selection.grammar") }}
          labels={{ keep: t("selection.keep"), discard: t("selection.discard"), placeholder: t("selection.placeholder"), retry: t("selection.retry"), more: t("selection.more"), fewer: t("selection.fewer"), send: t("selection.send"), editing: t("selection.thinking"), copy: t("selection.copy"), error: t("selection.error") }}
          onCopy={async () => { await copyText(picked.text); setPicked(null); }}
          onAction={async (action, custom) => {
            await onSend(selectionPrompt(picked.text, custom ? { custom: action } : { action: action as SelectionRequestAction }, t));
            setPicked(null);
          }}
        />
      </div>, document.body,
    ) : null}
  </div>;
}
