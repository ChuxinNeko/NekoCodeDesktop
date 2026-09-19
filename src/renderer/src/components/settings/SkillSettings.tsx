import { useCallback, useEffect, useState } from "react";
import type { SkillOrigin, SkillSummary, SkillsSnapshot } from "../../../../shared/skills";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";

/**
 * Which skills the agent knows about, and which of the shipped ones are on.
 *
 * A skill costs a name and a one-line description in every system prompt, and
 * buys a procedure the model can read when the task matches. That trade is the
 * whole reason this page exists: switching one off is how you take the line back
 * when you never use it.
 */

const ORIGIN_LABELS: Record<SkillOrigin, TranslationKey> = {
	builtin: "skills.origin.builtin",
	user: "skills.origin.user",
	project: "skills.origin.project",
	package: "skills.origin.package",
};

function OriginTag({ origin }: { origin: SkillOrigin }) {
	const { t } = useTranslation();
	return (
		<span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
			{t(ORIGIN_LABELS[origin])}
		</span>
	);
}

/** Name, description and path — the three things that identify a skill. */
function SkillRow({
	skill,
	action,
	dimmed,
}: {
	skill: SkillSummary;
	action?: React.ReactNode;
	dimmed?: boolean;
}) {
	return (
		<div className={cn("flex items-start gap-3 px-3 py-2.5", dimmed && "opacity-60")}>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<code className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
						{skill.name}
					</code>
					<OriginTag origin={skill.origin} />
				</div>
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{skill.description}
				</span>
				<span
					className="truncate font-mono text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground/80"
					title={skill.path}
				>
					{skill.path}
				</span>
			</div>
			{action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
		</div>
	);
}

function Card({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-border">
			{children}
		</div>
	);
}

function Note({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
			{children}
		</p>
	);
}

export function SkillSettings() {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(() => {
		api
			.skillsList()
			.then((value) => setSnapshot(value))
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		load();
		// Opening a project is what makes project skills discoverable, and it
		// arrives as a snapshot rather than as an event of its own.
		return api.onAgentSnapshot(() => load());
	}, [load]);

	const toggle = (skill: SkillSummary, enabled: boolean) => {
		setPending(skill.name);
		setError(null);
		// Paint the switch immediately: reloading the session's resources takes a
		// moment, and a switch that lags behind the finger reads as broken.
		setSnapshot((current) =>
			current
				? {
						...current,
						builtin: current.builtin.map((entry) =>
							entry.name === skill.name ? { ...entry, enabled } : entry,
						),
					}
				: current,
		);
		api
			.skillsSetEnabled({ name: skill.name, enabled })
			.then((value) => {
				if (value) setSnapshot(value);
			})
			.catch((cause: unknown) => {
				setError(errorMessage(cause));
				load();
			})
			.finally(() => setPending(null));
	};

	if (loading) {
		return (
			<section className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				<Spinner className="size-3.5" />
				{t("skills.loading")}
			</section>
		);
	}

	return <SkillSettingsView snapshot={snapshot} pending={pending} error={error} onToggle={toggle} />;
}

/**
 * The page itself, once there is something to show. Kept apart from the fetching
 * so the layout can be rendered from a fixture.
 */
export function SkillSettingsView({
	snapshot,
	pending,
	error,
	onToggle,
}: {
	snapshot: SkillsSnapshot | null;
	pending?: string | null;
	error?: string | null;
	onToggle: (skill: SkillSummary, enabled: boolean) => void;
}) {
	const { t } = useTranslation();
	const builtin = snapshot?.builtin ?? [];
	// Everything the session loaded that this page does not already list above.
	const discovered = (snapshot?.active ?? []).filter((skill) => skill.origin !== "builtin");

	return (
		<section className="flex flex-col gap-4">
			<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{t("skills.intro")}
			</p>

			<div className="flex flex-col gap-2">
				<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
					{t("skills.builtinTitle")}
				</h3>
				<Card>
					{builtin.length === 0 ? (
						<Note>{t("skills.builtinMissing")}</Note>
					) : (
						builtin.map((skill) => (
							<SkillRow
								key={skill.name}
								skill={skill}
								dimmed={!skill.enabled}
								action={
									<Switch
										checked={skill.enabled}
										disabled={pending === skill.name}
										onCheckedChange={(checked: boolean) => onToggle(skill, checked)}
									/>
								}
							/>
						))
					)}
				</Card>
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{t("skills.builtinHint")}
				</span>
			</div>

			<div className="flex flex-col gap-2">
				<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
					{t("skills.discoveredTitle")}
				</h3>
				<Card>
					{!snapshot ? (
						<Note>{t("skills.needSession")}</Note>
					) : discovered.length === 0 ? (
						<Note>{t("skills.discoveredEmpty")}</Note>
					) : (
						discovered.map((skill) => <SkillRow key={skill.path} skill={skill} />)
					)}
				</Card>
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{t("skills.addYourOwn")}
				</span>
				<div className="flex flex-col gap-0.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					<span className="truncate" title={snapshot?.directories.user}>
						{snapshot?.directories.user ?? "—"}
					</span>
					<span className="truncate" title={snapshot?.directories.project ?? undefined}>
						{snapshot?.directories.project ?? t("skills.noProject")}
					</span>
				</div>
			</div>

			{snapshot && snapshot.warnings.length > 0 ? (
				<div className="flex flex-col gap-1">
					<h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium">
						{t("skills.warningsTitle")}
					</h3>
					{snapshot.warnings.map((warning) => (
						<span
							key={warning}
							className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]"
						>
							{warning}
						</span>
					))}
				</div>
			) : null}

			{error ? (
				<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span>
			) : null}
		</section>
	);
}
