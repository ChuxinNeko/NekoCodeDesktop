import { useLayoutEffect, useRef, useState } from "react";
import { elapsedSeconds, formatElapsed, useNow } from "../../lib/elapsed";
import { ChevronDownIcon, ChevronRightIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";

export function lastThinkingLine(thinking: string): string {
	const lines = thinking
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

/**
 * The opened reasoning stream: a five-line window that follows the newest line.
 *
 * Reasoning runs to hundreds of lines, and letting it set the cell's height
 * pushed the answer — and the rest of the transcript — off screen. Following
 * the tail is what keeps a bounded box readable while it streams; it gives way
 * as soon as the user scrolls up, and takes over again at the bottom.
 */
export function ThinkingStream({ text }: { text: string }) {
	const ref = useRef<HTMLPreElement>(null);
	const followRef = useRef(true);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !followRef.current) return;
		el.scrollTop = el.scrollHeight;
	}, [text]);

	return (
		<pre
			ref={ref}
			onScroll={() => {
				const el = ref.current;
				if (!el) return;
				// The scroll above lands here too, and reads as still following.
				followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
			}}
			className={cn(
				// Five lines of the leading set right here. `em` resolves against
				// this element's own size, so the window stays five lines at every
				// UI density rather than at the one it was measured in.
				// Contained overscroll: reaching either end of five lines must not
				// hand the wheel to the transcript and throw the reader's place away.
				"max-h-[7.5em] overflow-y-auto overscroll-contain leading-[1.5]",
				"whitespace-pre-wrap break-words border-l border-border/60 pl-3",
				"text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70",
			)}
		>
			{text}
		</pre>
	);
}

/**
 * The thinking block, Codex-style: while the model reasons the header shimmers
 * "Thinking for Ns" with the latest line of reasoning underneath; once output
 * starts it settles to "Thought for Ns" and collapses to the header alone.
 * Reopened sessions carry no timing, so they read plain "Thought".
 *
 * Takes plain reasoning and timing rather than a cell, because the model is not
 * the only thing that reasons in this app — a background worker does too, and
 * its reasoning should not look like a different feature.
 */
export function ThinkingBlock({
	text,
	active,
	startedAt,
	endedAt,
	defaultOpen = false,
}: {
	text: string;
	/** Still reasoning: the header counts up and shimmers. */
	active: boolean;
	startedAt: number;
	/** Absent while active, and for history that carried no timing. */
	endedAt?: number;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const now = useNow(active);
	const seconds = elapsedSeconds(startedAt, active ? now : (endedAt ?? startedAt));
	const preview = lastThinkingLine(text);
	const label = active
		? `Thinking for ${formatElapsed(seconds)}`
		: endedAt !== undefined
			? `Thought for ${formatElapsed(seconds)}`
			: "Thought";

	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"inline-flex w-fit items-center gap-1 text-[length:var(--app-font-size-chat,12px)]",
					MUTED_LABEL_TEXT_CLASS_NAME,
				)}
			>
				{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				<span className={active ? "shimmer" : undefined}>{label}</span>
			</button>
			{open ? (
				<ThinkingStream text={text} />
			) : active && preview ? (
				<div className="truncate border-l border-border/60 pl-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
					{preview}
				</div>
			) : null}
		</div>
	);
}
