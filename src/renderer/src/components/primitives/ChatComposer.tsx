// Installed from https://www.beautifului.dev/r/chat-composer.json; live messages and bui tokens.
"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "../chat/Markdown";

/* ─────────────────────────────────────────────────────────
 * CHAT — interactive panel with tabs, replies, and composer.
 * Messages are supplied by the caller from the real model request.
 * ───────────────────────────────────────────────────────── */

export type ChatMessage = {
  id?: string;
  role?: "user" | "assistant";
  label: string;
  sub: string;
  time: string;
  body: string;
  pending?: boolean;
};

export type ChatComposerLabels = {
  initialPrompt: string;
  placeholder: string;
  prompt: string;
  send: string;
  action: string;
};

function Section({
  label,
  sub,
  time,
  body,
  resolving,
}: {
  label: string;
  sub: string;
  time: string;
  body: string;
  resolving?: boolean;
}) {
  return (
    <div
      className="flex w-full flex-col gap-1.5 transition-[opacity,filter,transform] duration-400"
      style={{
        opacity: resolving ? 0.55 : 1,
        filter: resolving ? "blur(0.5px)" : "blur(0)",
        transform: resolving ? "scale(0.985)" : "scale(1)",
        transformOrigin: "top left",
        transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        animation: "bui-fade-up 400ms cubic-bezier(0.23,1,0.32,1) both",
      }}
    >
      <div className="flex items-center gap-1 text-[12px] leading-[1.3]">
        <span className="font-medium text-bui-ink">{label}</span>
        <span className="text-bui-ink-2">{sub}</span>
        {time ? <span className="text-bui-ink">{time}</span> : null}
      </div>
      <div className="min-w-0 text-[13px] leading-normal break-words text-bui-ink"><Markdown text={body} /></div>
    </div>
  );
}

export default function ChatComposer({
  messages = [],
  suggestions = [],
  labels,
  onSend,
}: {
  variant?: string;
  /** Conversation messages, including pending replies, supplied by the caller. */
  messages?: ChatMessage[];
  /** header chips (tabs) for switching context */
  suggestions?: string[];
  /** prominent copy strings */
  labels: ChatComposerLabels;
  /** fired with the trimmed prompt text when the user sends */
  onSend?: (text: string) => void;
}) {
  const l = labels;
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState(suggestions[0] ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const busy = messages.some(message => message.pending);
  const canSend = draft.trim().length > 0 && !busy;

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages]);

  const send = () => {
    if (!canSend) return;
    const text = draft.trim();
    onSend?.(text);
    setDraft("");
  };

  return (
    <div className="flex h-[288px] w-full max-w-95 flex-col self-start overflow-hidden rounded-[14px] bg-bui-surface shadow-bui-card">
      {/* header — tabs + actions */}
      <div className="flex shrink-0 items-center justify-between border-b border-bui-line p-1.5">
        <div className="flex items-center">
          {suggestions.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
              className={`rounded-[6px] px-2 py-[3px] text-[13px] text-bui-ink transition-[background-color,opacity] duration-100 ${tab === item ? "bg-bui-field" : "opacity-50 hover:opacity-75"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {[
            <path key="p" d="M12 5v14M5 12h14" />,
            <g key="h"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></g>,
            <g key="e" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></g>,
          ].map((icon, i) => (
            <button
              key={i}
              type="button"
              aria-label={l.action} disabled
              className="flex size-6 items-center justify-center rounded-[6px] text-bui-ink-3
                transition-colors duration-100 hover:bg-bui-hover hover:text-bui-ink-2"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {icon}
              </svg>
            </button>
          ))}
        </div>
      </div>

      {/* conversation — fixed region so the card never changes shape */}
      <div ref={threadRef} aria-live="polite" aria-busy={busy} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-1">
        {messages.map((message, index) => message.role === "user" ? (
          <div key={message.id ?? index} className="flex justify-end pl-14">
            <div
              className="rounded-xl bg-bui-field px-3 py-1.5 text-[13px] leading-[1.4] whitespace-pre-wrap break-words text-bui-ink transition-[opacity,transform] duration-300"
              style={{
                opacity: 1,
                transform: "translateY(0)",
                transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            >
              {message.body}
            </div>
          </div>
        ) : (
          <Section key={message.id ?? index}
            label={message.label}
            sub={message.sub}
            time={message.time}
            body={message.body}
            resolving={message.pending}
          />
        ))}
      </div>

      {/* composer */}
      <div className="mt-auto shrink-0 p-1.5">
        <div
          role="presentation"
          onClick={() => inputRef.current?.focus()}
          className="flex cursor-text flex-col gap-2 rounded-bui-control border border-bui-line bg-bui-field p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-bui-line-strong focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.025)]"
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) send();
            }}
            placeholder={l.placeholder}
            aria-label={l.prompt}
            className="min-h-4.5 bg-transparent text-[13px] leading-[1.4] text-bui-ink outline-none placeholder:text-bui-ink-3"
          />
          <div className="flex items-center justify-end">
            <button
              type="button"
              aria-label={l.send}
              disabled={!canSend}
              onClick={send}
              className="flex size-7 items-center justify-center rounded-[8px]
                transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]"
              style={{
                background: canSend ? "var(--bui-ink)" : "var(--bui-line-strong)",
                color: canSend ? "var(--bui-surface)" : "var(--bui-ink-2)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
