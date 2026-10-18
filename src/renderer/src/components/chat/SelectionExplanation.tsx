import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { ExplanationChat, explanationLabels, explanationMessages, type ExplanationChatState } from "../../lib/explanationChat";
import ChatComposer from "../primitives/ChatComposer";

/** A temporary side chat; closing it cancels its request and discards its turns. */
export function SelectionExplanation({ original, modelKey, onClose }: {
  original: string; modelKey?: string | null; onClose: () => void;
}) {
  const { t, language } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const chat = useRef<ExplanationChat | null>(null);
  const titleId = useId();
  const sourceId = useId();
  const [state, setState] = useState<ExplanationChatState>({ turns: [], busy: false, error: false });

  useEffect(() => {
    const panel = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    panel?.showModal();
    return () => { panel?.close(); previous?.focus(); };
  }, []);

  const initialPrompt = t("selection.chat.initialPrompt");
  useEffect(() => {
    const conversation = new ExplanationChat({ original, modelKey: modelKey ?? null, language }, {
      request: request => api.explainSelection(request),
      cancel: id => api.cancelSelectionExplanation(id),
    }, setState);
    chat.current = conversation;
    void conversation.send(initialPrompt);
    return () => { conversation.dispose(); chat.current = null; };
  }, [original, modelKey, language, initialPrompt]);

  return createPortal(<dialog ref={dialog} aria-labelledby={titleId} aria-describedby={sourceId}
    className="beautiful-explanation-chat m-auto max-h-[90dvh] w-[min(95vw,404px)] overflow-y-auto rounded-[14px] bg-bui-surface p-3 text-bui-ink shadow-bui-overlay backdrop:bg-black/35"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 id={titleId} className="text-sm font-medium">{t("selection.chat.title")}</h2>
      <button type="button" onClick={onClose} aria-label={t("selection.chat.close")} className="rounded-md px-2 py-1 text-xs text-bui-ink-2 hover:bg-bui-hover">{t("selection.chat.close")}</button>
    </div>
    <p id={sourceId} className="mb-1 text-xs text-bui-ink-2">{t("selection.chat.source")}</p>
    <blockquote className="mb-3 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-bui-field p-2 text-[13px]">{original}</blockquote>
    <ChatComposer messages={explanationMessages(state, t)} suggestions={[t("selection.chat.context")]}
      labels={explanationLabels(t)} onSend={text => { void chat.current?.send(text); }} />
    {state.error ? <div role="alert" className="mt-2 flex items-center justify-between gap-2 text-xs text-bui-red">
      <span>{t(modelKey ? "selection.chat.error" : "selection.chat.noModel")}</span>
      <button type="button" className="shrink-0 rounded-md px-2 py-1 hover:bg-bui-hover" onClick={() => { void chat.current?.retry(); }}>{t("selection.retry")}</button>
    </div> : null}
  </dialog>, document.body);
}
