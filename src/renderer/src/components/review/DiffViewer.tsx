// FILE: DiffViewer.tsx
// Purpose: A file's diff with line numbers, in a unified or side-by-side layout,
//          with the changed part of each edited line picked out — the diff pane of
//          the review workbench.
// Layer: Review workbench

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DiffStat } from "../ui/diff-stat";
import { Spinner } from "../ui/spinner";
import { parseDiff, toSplitRows, pairedSpans, type DiffRow } from "./diff-parse";
import { useElementWidth, type DiffPrefs } from "./hooks";

/** Rows drawn before the "show more" button; a generated 50k-line diff would otherwise stall the UI. */
const ROW_PAGE = 2500;

const ADD_ROW = "bg-[color-mix(in_srgb,var(--success)_14%,transparent)]";
const DEL_ROW = "bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)]";
const ADD_GUTTER = "bg-[color-mix(in_srgb,var(--success)_24%,transparent)]";
const DEL_GUTTER = "bg-[color-mix(in_srgb,var(--destructive)_24%,transparent)]";
const ADD_MARK = "bg-[color-mix(in_srgb,var(--success)_38%,transparent)]";
const DEL_MARK = "bg-[color-mix(in_srgb,var(--destructive)_38%,transparent)]";
const GUTTER_TEXT = "text-muted-foreground/80";

function Text({ row, span }: { row: DiffRow; span: [number, number] | undefined }) {
	if (!span || span[0] === span[1]) return <>{row.text || " "}</>;
	const mark = row.kind === "add" ? ADD_MARK : DEL_MARK;
	return (
		<>
			{row.text.slice(0, span[0])}
			<span className={cn("rounded-[2px]", mark)}>{row.text.slice(span[0], span[1])}</span>
			{row.text.slice(span[1])}
		</>
	);
}

function Gutter({ value, tone }: { value: number | null; tone?: "add" | "del" }) {
	return (
		<span
			className={cn(
				"select-none px-2 text-right tabular-nums",
				GUTTER_TEXT,
				tone === "add" && ADD_GUTTER,
				tone === "del" && DEL_GUTTER,
			)}
		>
			{value ?? ""}
		</span>
	);
}

function FullRow({ row, noNewline }: { row: DiffRow; noNewline: string }) {
	if (row.kind === "note") {
		return (
			<div className="px-3 italic text-muted-foreground/80" title={row.text}>
				{noNewline}
			</div>
		);
	}
	if (row.kind === "file") {
		return (
			<div className="mt-2 border-y border-[color:var(--app-surface-divider)] bg-[var(--color-background-elevated-secondary)] px-3 py-1 font-medium text-foreground">
				{row.text}
			</div>
		);
	}
	return (
		<div className="bg-[var(--color-background-elevated-secondary)] px-3 text-muted-foreground">{row.text}</div>
	);
}

function Chip({ children, tone }: { children: ReactNode; tone?: "add" | "del" }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full border border-[color:var(--app-surface-divider)] px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)]",
				tone === "add" ? "text-success" : tone === "del" ? "text-destructive" : "text-muted-foreground",
			)}
		>
			{children}
		</span>
	);
}

export function DiffViewer({
	patch,
	loading,
	path,
	prefs,
	onPrefs,
	actions,
	empty,
}: {
	patch: string;
	loading: boolean;
	/** Shown in the toolbar; omit when the surrounding header already names the file. */
	path?: string | null;
	prefs: DiffPrefs;
	onPrefs: (next: DiffPrefs) => void;
	/** Buttons for the right end of the toolbar. */
	actions?: ReactNode;
	/** Shown when no file is selected. */
	empty?: ReactNode;
}) {
	const { t } = useTranslation();
	const rootRef = useRef<HTMLDivElement>(null);
	const width = useElementWidth(rootRef);
	const parsed = useMemo(() => parseDiff(patch), [patch]);
	const [limit, setLimit] = useState(ROW_PAGE);
	// A new patch starts from the top again.
	useEffect(() => setLimit(ROW_PAGE), [patch]);

	const rows = parsed.rows.length > limit ? parsed.rows.slice(0, limit) : parsed.rows;
	const hidden = parsed.rows.length - rows.length;
	const spans = useMemo(() => pairedSpans(rows), [rows]);
	const split = useMemo(() => (prefs.mode === "split" ? toSplitRows(rows) : []), [rows, prefs.mode]);
	const { meta } = parsed;
	const noNewline = t("review.diff.noNewline");

	const toolbar = (
		<div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[color:var(--app-surface-divider)] px-3 py-1">
			{path ? (
				<span className="min-w-24 flex-1 basis-40 truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground" title={path}>
					{path}
				</span>
			) : null}
			{meta.isNew ? <Chip tone="add">{t("review.diff.newFile")}</Chip> : null}
			{meta.isDeleted ? <Chip tone="del">{t("review.diff.deletedFile")}</Chip> : null}
			{meta.renameFrom ? <Chip>{t("review.diff.renamedFrom", { from: meta.renameFrom })}</Chip> : null}
			{meta.modeChange ? <Chip>{t("review.diff.mode", { change: meta.modeChange })}</Chip> : null}
			{loading ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
			<div className="ml-auto flex shrink-0 items-center gap-2">
			{parsed.additions + parsed.deletions > 0 ? (
				<DiffStat
					className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)]"
					insertions={parsed.additions}
					deletions={parsed.deletions}
				/>
			) : null}
			<Button
				aria-pressed={prefs.ignoreWhitespace}
				onClick={() => onPrefs({ ...prefs, ignoreWhitespace: !prefs.ignoreWhitespace })}
				size="xs"
				variant={prefs.ignoreWhitespace ? "subtle" : "chrome-outline"}
				title={t("review.diff.ignoreWs")}
			>
				<span className="font-mono">¶</span>
				{width >= 620 ? <span>{t("review.diff.ignoreWs")}</span> : null}
			</Button>
			<div className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--color-background-elevated-secondary)] p-0.5">
				{(["unified", "split"] as const).map((mode) => (
					<button
						key={mode}
						type="button"
						aria-pressed={prefs.mode === mode}
						onClick={() => onPrefs({ ...prefs, mode })}
						className={cn(
							"rounded-sm px-2 py-0.5 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
							prefs.mode === mode
								? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)]"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{t(mode === "unified" ? "review.diff.unified" : "review.diff.split")}
					</button>
				))}
			</div>
			{actions}
			</div>
		</div>
	);

	const message = (text: ReactNode) => (
		<p className="px-4 py-6 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{text}</p>
	);

	let body: ReactNode;
	if (path === null && !patch) {
		body = message(empty ?? t("review.diff.pick"));
	} else if (meta.isBinary) {
		body = message(t("review.diff.binary"));
	} else if (parsed.rows.length === 0) {
		body = loading ? message(t("review.diff.loading")) : message(prefs.ignoreWhitespace ? t("review.diff.wsOnly") : t("review.noChanges"));
	} else if (prefs.mode === "unified") {
		body = (
			<div className="w-max min-w-full py-1 font-mono text-[length:var(--app-font-size-chat-code,11px)] leading-5">
				{rows.map((row, index) =>
					row.kind === "context" || row.kind === "add" || row.kind === "del" ? (
						<div
							// Rows are positional and never reorder, so the index is the stable key.
							// eslint-disable-next-line react/no-array-index-key
							key={index}
							className={cn(
								"grid grid-cols-[3.25rem_3.25rem_1.25rem_minmax(0,1fr)]",
								row.kind === "add" && ADD_ROW,
								row.kind === "del" && DEL_ROW,
							)}
						>
							<Gutter value={row.oldNo} tone={row.kind === "del" ? "del" : undefined} />
							<Gutter value={row.newNo} tone={row.kind === "add" ? "add" : undefined} />
							<span className={cn("select-none text-center", GUTTER_TEXT)}>
								{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
							</span>
							<span className="whitespace-pre pr-3">
								<Text row={row} span={spans.get(row)} />
							</span>
						</div>
					) : (
						// eslint-disable-next-line react/no-array-index-key
						<FullRow key={index} row={row} noNewline={noNewline} />
					),
				)}
			</div>
		);
	} else {
		body = (
			<div className="w-full py-1 font-mono text-[length:var(--app-font-size-chat-code,11px)] leading-5">
				{split.map((entry, index) => {
					if (entry.type === "full") {
						// eslint-disable-next-line react/no-array-index-key
						return <FullRow key={index} row={entry.row} noNewline={noNewline} />;
					}
					const cell = (row: DiffRow | null, side: "left" | "right") => {
						const tone = row?.kind === "add" ? "add" : row?.kind === "del" ? "del" : undefined;
						return (
							<div
								className={cn(
									"grid min-w-0 grid-cols-[3rem_minmax(0,1fr)]",
									tone === "add" && ADD_ROW,
									tone === "del" && DEL_ROW,
									side === "right" && "border-l border-[color:var(--app-surface-divider)]",
									!row && "bg-[var(--color-background-elevated-secondary)]/50",
								)}
							>
								<Gutter value={row ? (side === "left" ? row.oldNo : row.newNo) : null} tone={tone} />
								<span className="whitespace-pre-wrap break-all px-2">
									{row ? <Text row={row} span={spans.get(row)} /> : null}
								</span>
							</div>
						);
					}
					return (
						// eslint-disable-next-line react/no-array-index-key
						<div key={index} className="grid grid-cols-2">
							{cell(entry.left, "left")}
							{cell(entry.right, "right")}
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
			{toolbar}
			<div className="min-h-0 flex-1 overflow-auto">
				{body}
				{hidden > 0 ? (
					<div className="flex justify-center p-3">
						<Button onClick={() => setLimit((current) => current + ROW_PAGE)} size="xs" variant="chrome-outline">
							{t("review.diff.showMore", { count: hidden.toLocaleString() })}
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}
