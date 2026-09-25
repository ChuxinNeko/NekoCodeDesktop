import { useEffect, useRef } from "react";
import type { SlashCommandSummary } from "../../../../shared/commands";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { FileIcon, SkillCubeIcon, ZapIcon } from "../../lib/icons";
import {
	COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
	COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
	COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
	COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
	COMPOSER_SURFACE_SHADOW_CLASS_NAME,
} from "./composerPickerStyles";

/**
 * Rank commands against what has been typed after the slash.
 *
 * A prefix match outranks a match further in, so typing `de` puts `/design`
 * above `/skill:code-review` — the name the user is most likely spelling out
 * should not be pushed down by an incidental hit in someone else's name.
 * Matching ignores the `skill:` prefix as well, so `/des` still finds a skill
 * the user thinks of simply as "design".
 */
export function filterCommands(
	commands: readonly SlashCommandSummary[],
	query: string,
): SlashCommandSummary[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...commands];
	const scored: Array<{ command: SlashCommandSummary; score: number }> = [];
	for (const command of commands) {
		const name = command.name.toLowerCase();
		const bare = name.startsWith("skill:") ? name.slice(6) : name;
		const rank = name.startsWith(needle) || bare.startsWith(needle)
			? 0
			: name.includes(needle)
				? 1
				: command.description.toLowerCase().includes(needle)
					? 2
					: -1;
		if (rank >= 0) scored.push({ command, score: rank });
	}
	// Stable within a rank: the backend already ordered prompts before skills.
	return scored
		.map((entry, index) => ({ ...entry, index }))
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map((entry) => entry.command);
}

interface ComposerCommandMenuProps {
	commands: readonly SlashCommandSummary[];
	/** Index into `commands`; the caller owns it so the textarea can drive it. */
	activeIndex: number;
	onHighlight: (index: number) => void;
	onPick: (command: SlashCommandSummary) => void;
}

/**
 * The list that opens when a message starts with a slash.
 *
 * Deliberately not a Base UI menu: it is driven entirely from the textarea's
 * keyboard handler, and a real menu would take focus away from the field the
 * user is still typing into.
 */
export function ComposerCommandMenu(props: ComposerCommandMenuProps) {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement | null>(null);

	// Follow the keyboard selection rather than the pointer: arrowing past the
	// bottom of a long skill list has to bring the row into view.
	useEffect(() => {
		const row = listRef.current?.querySelector(`[data-index="${String(props.activeIndex)}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [props.activeIndex]);

	return (
		<div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
			<div
				className={cn(
					COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
					COMPOSER_SURFACE_SHADOW_CLASS_NAME,
				)}
			>
				{props.commands.length === 0 ? (
					<div className="px-3 py-2.5 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("commands.empty")}
					</div>
				) : (
					<div
						ref={listRef}
						className="max-h-[min(18rem,45vh)] overflow-y-auto overscroll-contain p-1"
						role="listbox"
					>
						{props.commands.map((command, index) => {
							const Icon = command.kind === "skill" ? SkillCubeIcon : command.kind === "builtin" ? ZapIcon : FileIcon;
							return (
								<div
									key={`${command.kind}:${command.name}`}
									data-index={index}
									role="option"
									aria-selected={index === props.activeIndex}
									className={cn(
										COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
										index === props.activeIndex && COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
									)}
									// Pointer-down rather than click: the textarea must not lose
									// focus and close the menu before the pick lands.
									onPointerDown={(event) => {
										event.preventDefault();
										props.onPick(command);
									}}
									onPointerMove={() => props.onHighlight(index)}
								>
									<Icon className="size-3.5 shrink-0 opacity-70" />
									<span className="shrink-0 font-mono text-[length:var(--app-font-size-ui,12px)]">
										/{command.name}
									</span>
									{command.argumentHint ? (
										<span className="shrink-0 font-mono text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
											{command.argumentHint}
										</span>
									) : null}
									<span className="min-w-0 flex-1 truncate text-right text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
										{command.description}
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
