import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { ExplanationChat, explanationLabels, explanationMessages, type ExplanationChatState } from "../../lib/explanationChat";
import { selectionActionsPosition, type SelectionActionsPosition } from "../../lib/selectionActionsPosition";
import ChatComposer from "../primitives/ChatComposer";

/** A temporary side chat; closing it cancels its request and discards its turns. */
export function SelectionExplanation({ original, range, pointerOffsetX, modelKey, sessionId, onClose }: {
  original: string; range: Range; pointerOffsetX?: number; modelKey?: string | null; sessionId?: string; onClose: () => void;
}) {
  const { t, language } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const chat = useRef<ExplanationChat | null>(null);
  const [state, setState] = useState<ExplanationChatState>({ turns: [], busy: false, error: false });
  const [position, setPosition] = useState<SelectionActionsPosition>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.showModal();
    const place = () => {
      const next = selectionActionsPosition({
        rects: Array.from(range.getClientRects()),
        selectionLeft: range.getBoundingClientRect().left,
        pointerOffsetX,
        menuWidth: panel.offsetWidth,
        menuHeight: panel.offsetHeight,
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight,
      });
      if (next) setPosition(current => current.left === next.left && current.top === next.top ? current : next);
    };
    // Position before the first paint, then follow layout and viewport changes.
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      panel.close();
      previous?.focus();
    };
  }, [range, pointerOffsetX]);

  const initialPrompt = t("selection.chat.initialPrompt");
  useEffect(() => {
    const conversation = new ExplanationChat({ original, modelKey: modelKey ?? null, language, sessionId }, {
      request: request => api.explainSelection(request),
      cancel: id => api.cancelSelectionExplanation(id),
    }, setState);
    chat.current = conversation;
    void conversation.send(initialPrompt);
    return () => { conversation.dispose(); chat.current = null; };
  }, [original, modelKey, language, sessionId, initialPrompt]);

  return createPortal(<dialog ref={dialog} aria-label={t("selection.chat.title")}
    className="beautiful-explanation-chat fixed inset-auto m-0 max-h-[calc(100dvh-16px)] w-[min(calc(100vw-16px),380px)] overflow-y-auto border-0 bg-transparent p-0 text-bui-ink backdrop:bg-black/35"
    style={{ left: position.left, top: position.top }}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <ChatComposer messages={explanationMessages(state, t)} suggestions={[t("selection.chat.context")]}
      labels={explanationLabels(t)} onSend={text => { void chat.current?.send(text); }} />
    {state.error ? <div role="alert" className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-bui-surface p-2 text-xs text-bui-red">
      <span>{t(modelKey ? "selection.chat.error" : "selection.chat.noModel")}</span>
      <button type="button" className="shrink-0 rounded-md px-2 py-1 hover:bg-bui-hover" onClick={() => { void chat.current?.retry(); }}>{t("selection.retry")}</button>
    </div> : null}
  </dialog>, document.body);
}
