import type { ContextUsage } from "../../../../shared/agent";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Share of the window past which the ring stops being background information.
 *
 * PI auto-compacts somewhere in this region, so the colour change is a warning
 * that the conversation is about to be rewritten under the user — not a
 * decoration tied to a round number.
 */
const WARN_AT = 0.75;
const DANGER_AT = 0.9;

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function tokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
	return String(value);
}

/**
 * How full the context window is, as a ring beside the send button.
 *
 * A ring rather than a number, because the number is only interesting near the
 * top: at 12% it should cost no attention, and at 94% it should be the most
 * conspicuous thing in the footer. The figures behind it are a hover away.
 */
export function ContextGauge({ context }: { context: ContextUsage }) {
	const { t } = useTranslation();
	const ratio = Math.min(Math.max(context.used / context.window, 0), 1);
	const percent = Math.round(ratio * 100);
	const level = ratio >= DANGER_AT ? "danger" : ratio >= WARN_AT ? "warn" : "calm";
	const stroke =
		level === "danger"
			? "var(--destructive)"
			: level === "warn"
				? "var(--warning)"
				: "var(--color-text-accent)";

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={t("context.label", { percent: String(percent) })}
						// Nothing to press: the ring is a readout, and the detail it can
						// show is already on hover and on focus.
						className={cn(
							"flex size-7 shrink-0 cursor-default items-center justify-center rounded-md outline-none",
							"transition-colors focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]/60",
							"hover:bg-[var(--color-background-elevated-secondary)]",
						)}
					>
						<svg aria-hidden="true" viewBox="0 0 18 18" className="size-4.5 -rotate-90">
							<circle
								cx="9"
								cy="9"
								r={RADIUS}
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								className="text-muted-foreground/25"
							/>
							<circle
								cx="9"
								cy="9"
								r={RADIUS}
								fill="none"
								stroke={stroke}
								strokeWidth="2"
								strokeLinecap="round"
								strokeDasharray={CIRCUMFERENCE}
								strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
								className="transition-[stroke-dashoffset] duration-300"
							/>
						</svg>
					</button>
				}
			/>
			<TooltipPopup viewportClassName="p-0" className="max-w-64">
				<div className="flex flex-col gap-1.5 px-2.5 py-2">
					<div className="flex items-baseline justify-between gap-4">
						<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
							{t("context.title")}
						</span>
						<span
							className={cn(
								"font-mono text-[length:var(--app-font-size-ui,12px)]",
								level === "danger"
									? "text-destructive"
									: level === "warn"
										? "text-[var(--warning)]"
										: "text-muted-foreground",
							)}
						>
							{percent}%
						</span>
					</div>
					<div className="flex items-baseline justify-between gap-4 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						<span>{t("context.used")}</span>
						<span className="font-mono">
							{tokens(context.used)} / {tokens(context.window)}
						</span>
					</div>
					<p className="text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground">
						{level === "calm" ? t("context.hint") : t("context.hintNearFull")}
					</p>
				</div>
			</TooltipPopup>
		</Tooltip>
	);
}
