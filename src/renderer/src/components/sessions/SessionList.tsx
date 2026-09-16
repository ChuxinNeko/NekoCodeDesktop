import { useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../../../shared/agent";
import { groupSessions, type SessionBucketId } from "../../../../shared/sessions";
import { useNow } from "../../hooks/useNow";
import { useTranslation, type TranslationKey } from "../../i18n";
import { SearchIcon, XIcon } from "../../lib/icons";
import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "../../lib/sidebarRowStyles";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SessionRow } from "./SessionRow";

/** Relative timestamps only ever change by the minute, so that is how often they re-render. */
const CLOCK_INTERVAL_MS = 60_000;

/** Below this the search field is more chrome than help. */
const SEARCH_THRESHOLD = 6;

const BUCKET_LABEL_KEYS: Record<SessionBucketId, TranslationKey> = {
	today: "sessions.bucket.today",
	yesterday: "sessions.bucket.yesterday",
	week: "sessions.bucket.week",
	month: "sessions.bucket.month",
	older: "sessions.bucket.older",
};

export interface SessionListProps {
	sessions: SessionSummary[];
	activeId: string | null;
	/** The active session is mid-run. */
	streaming: boolean;
	loading: boolean;
	/** No project is open yet, so there is nothing to list. */
	hasProject: boolean;
	onOpen: (session: SessionSummary) => void;
	onRename: (session: SessionSummary, title: string) => void;
	onDelete: (session: SessionSummary) => void;
}

/**
 * The sidebar's session list: search, date grouping, and per-row rename/delete.
 *
 * Grouping and filtering live in `shared/sessions` so the bucket boundaries are
 * tested directly; this component only decides what to draw.
 */
export function SessionList(props: SessionListProps) {
	const { t } = useTranslation();
	const { sessions, activeId, hasProject, loading } = props;
	const now = useNow(CLOCK_INTERVAL_MS);
	const [query, setQuery] = useState("");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const buckets = useMemo(
		() => groupSessions(sessions, { now, query }),
		[sessions, now, query],
	);
	const matchCount = buckets.reduce((total, bucket) => total + bucket.sessions.length, 0);

	/**
	 * Arrow keys walk the rows, F2 renames and Delete removes the focused one —
	 * handled at the list so a row never has to know about its neighbours.
	 */
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "F2") return;
		const container = listRef.current;
		if (!container) return;
		const rows = [...container.querySelectorAll<HTMLElement>("[data-session-file]")];
		const index = rows.indexOf(document.activeElement as HTMLElement);
		if (index === -1) return;

		if (event.key === "F2") {
			event.preventDefault();
			const file = rows[index]?.dataset.sessionFile;
			if (file) setRenaming(file);
			return;
		}
		event.preventDefault();
		const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
		next?.focus();
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1 px-2 pt-2">
			<div className="flex items-center justify-between px-2">
				<span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{t("sessions.title")}</span>
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/50">
					{query ? `${matchCount}/${sessions.length}` : sessions.length}
				</span>
			</div>

			{sessions.length >= SEARCH_THRESHOLD ? (
				<div className="relative flex items-center px-1">
					<SearchIcon className="pointer-events-none absolute left-2.5 size-3 text-muted-foreground/50" />
					<input
						aria-label={t("sessions.searchAria")}
						className={cn(
							"w-full rounded-md border border-transparent bg-[var(--color-background-control-opaque,transparent)]",
							"py-1 pl-7 pr-6 text-[length:var(--app-font-size-ui-sm,11px)] text-foreground outline-none",
							"placeholder:text-muted-foreground/50 focus:border-[color:var(--color-border-focus)]",
						)}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setQuery("");
						}}
						placeholder={t("sessions.search")}
						type="text"
						value={query}
					/>
					{query ? (
						<Button
							aria-label={t("sessions.clearSearch")}
							className="absolute right-1.5"
							onClick={() => setQuery("")}
							size="icon-xs"
							variant="ghost"
						>
							<XIcon className="size-3" />
						</Button>
					) : null}
				</div>
			) : null}

			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handling is the point here. */}
			<div
				className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-1"
				onKeyDown={onKeyDown}
				ref={listRef}
			>
				{!hasProject ? (
					<EmptyNote>{t("sessions.chooseProject")}</EmptyNote>
				) : loading && sessions.length === 0 ? (
					<EmptyNote>{t("sessions.loading")}</EmptyNote>
				) : sessions.length === 0 ? (
					<EmptyNote>{t("sessions.empty")}</EmptyNote>
				) : matchCount === 0 ? (
					<EmptyNote>{t("sessions.noMatch", { query: query.trim() })}</EmptyNote>
				) : (
					buckets.map((bucket) => (
						<section className="flex flex-col gap-0.5" key={bucket.id}>
							<h3
								className={cn(
									SIDEBAR_SECTION_LABEL_CLASS_NAME,
									"px-2 pb-0.5 pt-2 first:pt-0.5",
								)}
							>
								{t(BUCKET_LABEL_KEYS[bucket.id])}
							</h3>
							{bucket.sessions.map((session) => (
								<SessionRow
									active={session.id === activeId}
									confirmingDelete={confirmingDelete === session.sessionFile}
									key={session.sessionFile}
									now={now}
									onCancelDelete={() => setConfirmingDelete(null)}
									onCancelRename={() => setRenaming(null)}
									onDelete={() => {
										setConfirmingDelete(null);
										props.onDelete(session);
									}}
									onOpen={() => props.onOpen(session)}
									onRename={(title) => {
										setRenaming(null);
										props.onRename(session, title);
									}}
									onStartDelete={() => {
										setRenaming(null);
										setConfirmingDelete(session.sessionFile);
									}}
									onStartRename={() => {
										setConfirmingDelete(null);
										setRenaming(session.sessionFile);
									}}
									renaming={renaming === session.sessionFile}
									running={props.streaming && session.id === activeId}
									session={session}
								/>
							))}
						</section>
					))
				)}
			</div>
		</div>
	);
}

function EmptyNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">
			{children}
		</p>
	);
}
