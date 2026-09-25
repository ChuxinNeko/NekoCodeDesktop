import { useEffect, useRef } from "react";
import type { MentionCandidate } from "../../../../shared/mentions";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { CodeIcon, FileIcon, FolderIcon } from "../../lib/icons";
import {
	COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
	COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
	COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
	COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
	COMPOSER_SURFACE_SHADOW_CLASS_NAME,
} from "./composerPickerStyles";

const ICONS = { file: FileIcon, dir: FolderIcon, symbol: CodeIcon } as const;

interface ComposerMentionMenuProps {
	candidates: readonly MentionCandidate[];
	/** Still waiting on the first answer for this query. */
	loading: boolean;
	/** The query is a symbol search (`@#…`). */
	symbols: boolean;
	activeIndex: number;
	onHighlight: (index: number) => void;
	onPick: (candidate: MentionCandidate) => void;
}

/**
 * The list that opens on `@`: files and folders, or symbols after `@#`.
 *
 * Driven from the textarea's keyboard handler like the slash menu, and for the
 * same reason — a real menu would take focus from the field being typed in.
 */
export function ComposerMentionMenu(props: ComposerMentionMenuProps) {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const row = listRef.current?.querySelector(`[data-index="${String(props.activeIndex)}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [props.activeIndex]);

	const empty = props.loading
		? t("mentions.loading")
		: props.symbols
			? t("mentions.emptySymbols")
			: t("mentions.empty");

	return (
		<div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
			<div className={cn(COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME, COMPOSER_SURFACE_SHADOW_CLASS_NAME)}>
				{props.candidates.length === 0 ? (
					<div className="px-3 py-2.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{empty}</div>
				) : (
					<div
						ref={listRef}
						className="max-h-[min(18rem,45vh)] overflow-y-auto overscroll-contain p-1"
						role="listbox"
					>
						{props.candidates.map((candidate, index) => {
							const Icon = ICONS[candidate.kind];
							const slash = candidate.path.lastIndexOf("/");
							const name = candidate.kind === "symbol" ? (candidate.symbol ?? "") : candidate.path.slice(slash + 1);
							const where =
								candidate.kind === "symbol"
									? `${candidate.path}${candidate.line ? `:${String(candidate.line)}` : ""}`
									: slash > 0
										? candidate.path.slice(0, slash)
										: "";
							return (
								<div
									key={`${candidate.kind}:${candidate.path}:${candidate.symbol ?? ""}:${String(candidate.line ?? "")}`}
									data-index={index}
									role="option"
									aria-selected={index === props.activeIndex}
									className={cn(
										COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
										index === props.activeIndex && COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
									)}
									onPointerDown={(event) => {
										event.preventDefault();
										props.onPick(candidate);
									}}
									onPointerMove={() => props.onHighlight(index)}
								>
									<Icon className="size-3.5 shrink-0 opacity-70" />
									<span className="shrink-0 font-mono text-[length:var(--app-font-size-ui,12px)]">
										{name}
										{candidate.kind === "dir" ? "/" : ""}
									</span>
									{candidate.detail ? (
										<span className="shrink-0 font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
											{candidate.detail}
										</span>
									) : null}
									<span className="min-w-0 flex-1 truncate text-right font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground" dir="rtl">
										{/* rtl so a long path truncates at its start and keeps the part that tells files apart. */}
										<bdi>{where}</bdi>
									</span>
								</div>
							);
						})}
					</div>
				)}
				<div className="border-t border-[color:var(--app-surface-divider)] px-3 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
					{t("mentions.hint")}
				</div>
			</div>
		</div>
	);
}
