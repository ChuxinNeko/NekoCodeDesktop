import { useTranslation } from "../i18n";
import { BotIcon, CodeIcon } from "../lib/icons";
import { cn } from "../lib/utils";

/** The two ways the window can be laid out: the agent conversation first, or the editor first. */
export type LayoutMode = "agent" | "ide";

const MODES: ReadonlyArray<{ mode: LayoutMode; icon: typeof BotIcon; labelKey: "layout.agent" | "layout.ide" }> = [
	{ mode: "agent", icon: BotIcon, labelKey: "layout.agent" },
	{ mode: "ide", icon: CodeIcon, labelKey: "layout.ide" },
];

/**
 * The Agent ⇄ IDE control shared by settings and first-launch setup. A segmented control with a thumb
 * that slides between the halves, so the switch reads as one control with two
 * positions rather than two unrelated buttons.
 */
export function LayoutModeSwitch({ value, onChange }: { value: LayoutMode; onChange: (mode: LayoutMode) => void }) {
	const { t } = useTranslation();
	const index = MODES.findIndex((entry) => entry.mode === value);
	return (
		<div
			role="radiogroup"
			aria-label={t("layout.switch")}
			className="relative grid shrink-0 grid-cols-2 rounded-full bg-[var(--color-background-elevated-secondary)] p-0.5"
			onKeyDown={(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				onChange(value === "agent" ? "ide" : "agent");
			}}
		>
			<span
				aria-hidden="true"
				className="absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full bg-[var(--composer-surface)] shadow-sm transition-transform duration-200 ease-out"
				style={{ transform: `translateX(${index * 100}%)` }}
			/>
			{MODES.map(({ mode, icon: Icon, labelKey }) => (
				<button
					key={mode}
					type="button"
					role="radio"
					aria-checked={value === mode}
					tabIndex={value === mode ? 0 : -1}
					onClick={() => onChange(mode)}
					className={cn(
						"relative z-1 flex h-5 items-center justify-center gap-1 rounded-full px-2.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium transition-colors",
						value === mode ? "text-foreground" : "text-muted-foreground hover:text-foreground",
					)}
				>
					<Icon className="size-3" />
					{t(labelKey)}
				</button>
			))}
		</div>
	);
}
