// Installed by shadcn from beautifului.dev/r/selection-actions.json; adapted for live selections.
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ChatBubbleQuestion,
  Copy,
  Check,
  EmojiSatisfied,
  NavArrowRight,
  Refresh,
  Scissor,
  Spark,
  TextBox,
  Xmark,
} from "iconoir-react";
import { Button } from "../beautiful-ui/Button";
import { Shimmer } from "../beautiful-ui/Shimmer";
import { StreamText } from "../beautiful-ui/StreamText";

/* ─────────────────────────────────────────────────────────
 * SELECTION ACTIONS
 * A contextual AI bar attached beneath selected text.
 * The global theme owns its surface; this component only
 * composes existing surface, ink, accent, radius and motion
 * tokens.
 * ───────────────────────────────────────────────────────── */

/* A single AI action offered in the bar; labels are supplied by i18n. */
export type SelectionAction = {
  id: string;
  label?: string;
  icon: ReactNode;
  action?: string;
  busyLabel?: string;
};

/* The action set: `primary` are always visible; `more` reveal on expand. */
export type SelectionActionSet = {
  primary: SelectionAction[];
  more: SelectionAction[];
};

/* Prominent copy strings. */
export type SelectionActionsLabels = {
  keep: string;
  discard: string;
  placeholder: string;
  retry: string;
  more: string;
  fewer: string;
  send: string;
  editing: string;
  copy: string;
  error: string;
};

type Mode = "idle" | "thinking" | "streaming" | "result";

const iconProps = {
  width: 14,
  height: 14,
  strokeWidth: 1.8,
  "aria-hidden": true,
} as const;

const icons = {
  copy: <Copy {...iconProps} />,
  explain: <ChatBubbleQuestion {...iconProps} />,
  improve: <Spark {...iconProps} />,
  shorten: <Scissor {...iconProps} />,
  tone: <EmojiSatisfied {...iconProps} />,
  grammar: <TextBox {...iconProps} />,
  send: (
    <ArrowUp
      width="16"
      height="16"
      strokeWidth="2.4"
      aria-hidden="true"
    />
  ),
  chevron: <NavArrowRight {...iconProps} />,
  check: <Check {...iconProps} />,
  close: <Xmark {...iconProps} />,
  retry: <Refresh {...iconProps} />,
};

/* the single "keep" affirm — solid ink with a hairline (not the atom's filled
 * highlight) shadow, so it stays a local one-off rather than a Button variant */
const primary =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-bui-ink px-2.5 text-[12.5px] font-normal text-bui-canvas shadow-bui-hairline transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96]";


export type SelectionActionsProps = {
  range: Range;
  labels: SelectionActionsLabels;
  actionLabels: Record<"explain" | "improve" | "shorten" | "tone" | "grammar", string>;
  onAction: (action: string, custom?: boolean) => Promise<void> | void;
  onCopy: () => Promise<void>;
  /** Optional real model output for a local preview; never changes the transcript. */
  preview?: string;
};

export default function SelectionActions({
  range,
  actionLabels,
  labels: copy,
  onAction,
  onCopy,
  preview,
}: SelectionActionsProps) {
  const actions: SelectionActionSet = {
    primary: [
      { id: "explain", label: actionLabels.explain, icon: icons.explain, action: "explain" },
      { id: "improve", label: actionLabels.improve, icon: icons.improve, action: "improve" },
    ],
    more: [
      { id: "shorten", label: actionLabels.shorten, icon: icons.shorten, action: "shorten" },
      { id: "tone", label: actionLabels.tone, icon: icons.tone, action: "tone" },
      { id: "grammar", label: actionLabels.grammar, icon: icons.grammar, action: "grammar" },
    ],
  };
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [action, setAction] = useState("improve");
  const [prompt, setPrompt] = useState("");
  const [typingWidth, setTypingWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const previousModeRef = useRef<Mode>("idle");
  const lastWidthRef = useRef(0);
  const widthAnimationRef = useRef<Animation | null>(null);

  useEffect(() => {
    if (preview) setMode("streaming");
  }, [preview]);

  /* Attach beneath the final selected line, while centering the bar
   * against the complete selection bounds. requestAnimationFrame batches
   * streaming reflow measurements and avoids visible intermediate positions. */
  const place = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const host = hostRef.current;
      const selection = range;
      if (!host || !selection) return;

      const bounds = selection.getBoundingClientRect();
      const lines = Array.from(selection.getClientRects());
      const lastLine = lines.at(-1);
      if (!lastLine) return;

      const hostBounds = host.getBoundingClientRect();
      const halfWidth = Math.min((barRef.current?.getBoundingClientRect().width ?? 0) / 2, window.innerWidth / 2 - 8);
      const next = {
        x: Math.round(Math.max(halfWidth + 8, Math.min(window.innerWidth - halfWidth - 8, bounds.left + bounds.width / 2)) - hostBounds.left),
        y: Math.round(lastLine.bottom - hostBounds.top + 8),
      };

      setAnchor((current) =>
        current.x === next.x && current.y === next.y ? current : next,
      );
      setPositioned(true);
    });
  }, [range]);

  useLayoutEffect(() => {
    place();
  }, [mode, expanded, place]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(place);
    observer.observe(host);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [place]);

  /* Intrinsic width handles the preset expansion. When the entire content
   * changes between idle, loading and confirmation, animate from the last
   * rendered width to the new intrinsic width before the browser paints. */
  useLayoutEffect(() => {
    const bar = barRef.current;
    const content = contentRef.current;
    if (!bar || !content) return;

    const nextWidth = Math.ceil(content.getBoundingClientRect().width) + 8;
    const previousWidth =
      lastWidthRef.current || Math.ceil(bar.getBoundingClientRect().width);

    if (
      previousModeRef.current !== mode &&
      Math.abs(nextWidth - previousWidth) > 1
    ) {
      widthAnimationRef.current?.cancel();
      const animation = bar.animate(
        [
          { width: `${previousWidth}px` },
          { width: `${nextWidth}px` },
        ],
        {
          duration: 320,
          easing: "cubic-bezier(0.23,1,0.32,1)",
        },
      );
      widthAnimationRef.current = animation;
      animation.onfinish = () => {
        lastWidthRef.current = nextWidth;
        widthAnimationRef.current = null;
      };
    } else {
      lastWidthRef.current = nextWidth;
    }

    previousModeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (widthAnimationRef.current?.playState === "running") return;
      lastWidthRef.current =
        Math.ceil(content.getBoundingClientRect().width) + 8;
      place();
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      widthAnimationRef.current?.cancel();
    };
  }, [place]);

  const pendingRef = useRef(false);
  const run = async (nextAction: string, custom = false) => {
    if (!nextAction.trim() || pendingRef.current) return;
    pendingRef.current = true;
    setError(false);
    setAction(nextAction);
    setExpanded(false);
    setMode("thinking");
    try {
      await onAction(nextAction, custom);
      reset();
    } catch {
      setError(true);
      setMode("idle");
    } finally {
      pendingRef.current = false;
    }
  };

  const reset = () => {
    setExpanded(false);
    setPrompt("");
    setTypingWidth(null);
    setAction("improve");
    setMode("idle");
  };

  const busy = mode === "thinking" || mode === "streaming";
  const visible = positioned;
  const hasPrompt = prompt.trim().length > 0;
  const busyLabelMap: Record<string, string> = {};
  for (const item of [...actions.primary, ...actions.more]) {
    if (item.action && item.busyLabel) busyLabelMap[item.action] = item.busyLabel;
  }
  const busyLabel = busyLabelMap[action] ?? copy.editing;

  return (
    <div className="w-full max-w-[460px]">
      <div ref={hostRef} className="relative select-none">
        {preview && (mode === "streaming" || mode === "result") ? (
          <div className="text-[13px] text-bui-ink">
            {mode === "streaming" ? <StreamText text={preview} onProgress={place} onDone={() => setMode("result")} /> : preview}
          </div>
        ) : null}

        <div
          className="absolute top-0 left-0 z-10"
          style={{
            transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translateX(-50%)`,
            transition:
              "transform 320ms cubic-bezier(0.77,0,0.175,1), opacity 180ms ease-out",
            opacity: visible ? 1 : 0,
            pointerEvents: visible ? "auto" : "none",
            willChange: "transform",
          }}
        >
          {error ? <p role="alert" className="absolute top-full mt-1 rounded-md bg-bui-surface px-2 py-1 text-xs text-bui-red shadow-bui-card">{copy.error}</p> : null}
          {/* A 36px pill wraps 28px controls at a 4px inset. The controls
              resolve to a 14px radius, preserving the concentric curve. */}
          <div
            ref={barRef}
            className="flex h-9 w-fit max-w-[calc(100vw-16px)] items-center justify-center gap-0.5 overflow-x-auto rounded-full bg-bui-surface p-1 font-sans font-normal text-bui-ink shadow-bui-overlay"
            style={{
              width:
                mode === "idle" && hasPrompt && typingWidth
                  ? typingWidth
                  : undefined,
              ...(visible
                ? {
                    animation:
                      "bui-pop-in 220ms cubic-bezier(0.23,1,0.32,1) both",
                  }
                : {}),
            }}
          >
            <div
              ref={contentRef}
              className="flex w-fit shrink-0 items-center justify-center gap-0.5"
              style={{
                width:
                  mode === "idle" && hasPrompt && typingWidth
                    ? typingWidth - 8
                    : undefined,
              }}
            >
            {busy && (
              <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap px-2.5 text-[12.5px] font-normal text-bui-ink-2">
                <span
                  className="size-3 shrink-0 rounded-full border-[1.5px] border-bui-line-strong border-t-ink-2"
                  style={{ animation: "bui-spin 700ms linear infinite" }}
                />
                {mode === "thinking" ? (
                  <Shimmer className="text-[12.5px] font-normal">
                    {busyLabel}…
                  </Shimmer>
                ) : (
                  <span>{busyLabel}…</span>
                )}
              </span>
            )}

            {mode === "result" && (
              <>
                <button
                  type="button"
                  onClick={reset}
                  className={primary}
                >
                  {icons.check}
                  {copy.keep}
                </button>
                <Button type="button" variant="quiet" size="xs" className="shrink-0" onClick={reset}>
                  {icons.close}
                  {copy.discard}
                </Button>
                <span className="mx-0.5 h-4 w-px shrink-0 bg-bui-line" />
                <button
                  type="button"
                  aria-label={copy.retry}
                  onClick={() => run(action)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-bui-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-bui-hover-2 hover:text-bui-ink-2 active:scale-[0.96]"
                >
                  {icons.retry}
                </button>
              </>
            )}

            {mode === "idle" && (
              <>
                <div
                  className="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: expanded
                      ? 0
                      : hasPrompt && typingWidth
                        ? typingWidth - 40
                        : 145,
                    opacity: expanded ? 0 : 1,
                    transform: expanded ? "translateX(-8px)" : "translateX(0)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  <form
                    className="flex h-7 shrink-0 items-center transition-[width] duration-400"
                    style={{
                      width:
                        hasPrompt && typingWidth ? typingWidth - 40 : 145,
                      transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                    }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(prompt.trim(), true);
                    }}
                  >
                    <input
                      value={prompt}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (!prompt.trim() && next.trim()) {
                          setTypingWidth(
                            Math.ceil(
                              barRef.current?.getBoundingClientRect().width ??
                                0,
                            ),
                          );
                        } else if (!next.trim()) {
                          setTypingWidth(null);
                        }
                        setPrompt(next);
                      }}
                      aria-label={copy.placeholder}
                      placeholder={copy.placeholder}
                      className="h-7 w-full bg-transparent pr-2.5 pl-3 text-[12.5px] text-bui-ink placeholder:text-bui-ink-3"
                    />
                  </form>
                </div>

                <div
                  className="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: hasPrompt ? 0 : expanded ? 600 : 320,
                    opacity: hasPrompt ? 0 : 1,
                    transform: hasPrompt ? "translateX(-8px)" : "translateX(0)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  {!expanded && (
                    <span className="mx-1 h-4 w-px shrink-0 bg-bui-line-strong" />
                  )}
                  {actions.primary.map((item) => (
                    <Button
                      key={item.id}
                      type="button"
                      variant="quiet"
                      size="xs"
                      className="shrink-0"
                      onClick={item.action ? () => run(item.action!) : undefined}
                    >
                      {item.icon}
                      {item.label ?? item.id}
                    </Button>
                  ))}

                  <div
                    className="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,margin] duration-400"
                    style={{
                      maxWidth: expanded ? 350 : 0,
                      opacity: expanded ? 1 : 0,
                      marginLeft: expanded ? 2 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                    }}
                  >
                  {actions.more.map((item) => (
                    <Button
                      key={item.id}
                      type="button"
                      variant="quiet"
                      size="xs"
                      className="shrink-0"
                      onClick={item.action ? () => run(item.action!) : undefined}
                    >
                      {item.icon}
                      {item.label ?? item.id}
                    </Button>
                  ))}
                  </div>

                  <Button type="button" variant="quiet" size="xs" className="shrink-0" onClick={() => { void onCopy().catch(() => setError(true)); }}>
                    {icons.copy}{copy.copy}
                  </Button>
                  <span className="mx-0.5 h-4 w-px shrink-0 bg-bui-line" />
                  <button
                    type="button"
                    aria-label={expanded ? copy.fewer : copy.more}
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-bui-ink transition-[background-color,transform] duration-200 hover:bg-bui-hover active:scale-[0.96]"
                  >
                    <span
                      className="flex transition-transform duration-400"
                      style={{
                        transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                        transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                      }}
                    >
                      {icons.chevron}
                    </span>
                  </button>
                </div>

                <div
                  className="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: hasPrompt ? 30 : 0,
                    opacity: hasPrompt ? 1 : 0,
                    transform: hasPrompt ? "scale(1)" : "scale(0.88)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  <button
                    type="button"
                    aria-label={copy.send}
                    onClick={() => void run(prompt.trim(), true)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bui-ink text-bui-surface transition-[opacity,transform] duration-200 active:scale-[0.94]"
                  >
                    {icons.send}
                  </button>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
