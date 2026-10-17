import type { SlashCommandSummary } from "../../../../shared/commands";
import { useTranslation } from "../../i18n";
import PromptBar from "../PromptBar";
import { COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME } from "./composerPickerStyles";

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

/** Command data and keyboard selection remain owned by ComposerShell. */
export function ComposerCommandMenu(props: ComposerCommandMenuProps) {
	const { t } = useTranslation();
	return (
		<div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
			<PromptBar
				items={props.commands.map((command) => ({
					key: `${command.kind}:${command.name}`,
					name: `/${command.name}`,
					description: command.description,
					argumentHint: command.argumentHint,
				}))}
				activeIndex={props.activeIndex}
				label={t("picker.slashCommands")}
				emptyLabel={t("commands.empty")}
				searchHint={t("commands.searchHint")}
				keyboardHint={t("commands.keyboardHint")}
				onHighlight={props.onHighlight}
				onPick={(index) => {
					const command = props.commands[index];
					if (command) props.onPick(command);
				}}
			/>
		</div>
	);
}
