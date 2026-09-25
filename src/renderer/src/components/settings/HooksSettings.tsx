import { useEffect, useState } from "react";
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	MAX_HOOK_TIMEOUT_MS,
	validateHook,
	type HookConfig,
	type HookRunRecord,
	type HooksSnapshot,
	type SaveHookRequest,
} from "../../../../shared/hooks";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { HammerIcon, PlusIcon, TrashCanIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SETTINGS_TEXTAREA_CLASS_NAME, SettingsDialog } from "./SettingsDialog";

/** The project picker's "every project" entry; Select wants a non-empty value. */
const ALL_PROJECTS = "*";

const HINT_CLASS_NAME = "text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground";
const CHIP_CLASS_NAME =
	"shrink-0 rounded bg-[var(--color-background-elevated-secondary)] px-1.5 py-0.5 font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground";

interface Draft extends Omit<SaveHookRequest, "tools" | "timeoutMs"> {
	/** Comma-separated as typed; split on save. */
	tools: string;
	timeoutSeconds: string;
}

const BLANK: Draft = {
	name: "",
	enabled: true,
	event: "pre_tool",
	tools: "",
	pattern: "",
	action: "block",
	command: "",
	message: "",
	project: "",
	timeoutSeconds: String(DEFAULT_HOOK_TIMEOUT_MS / 1000),
};

/**
 * Starting points for the hooks people most often want. Picking one fills the
 * form; nothing is saved until the user has read it and pressed save.
 */
const TEMPLATES: Array<{ labelKey: TranslationKey; draft: Draft }> = [
	{
		labelKey: "hooks.template.dangerousDelete",
		draft: {
			...BLANK,
			name: "拦截递归强制删除",
			tools: "bash, powershell",
			pattern: String.raw`\brm\s+-[a-z]*(rf|fr)\b|\bRemove-Item\b.*-Recurse`,
			action: "block",
			message: "不允许递归强制删除。确需删除时请先向用户说明并取得同意。",
		},
	},
	{
		labelKey: "hooks.template.protectEnv",
		draft: {
			...BLANK,
			name: "保护 .env 文件",
			tools: "write, edit",
			pattern: String.raw`(^|[\\/])\.env(\.|$)`,
			action: "block",
			message: ".env 文件包含凭据，不允许由 agent 修改。",
		},
	},
	{
		labelKey: "hooks.template.prettier",
		draft: {
			...BLANK,
			name: "编辑后 Prettier 格式化",
			event: "post_tool",
			tools: "write, edit",
			pattern: String.raw`\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|html|vue)$`,
			action: "command",
			command: 'npx --no-install prettier --write "$NEKOCODE_FILE"',
		},
	},
	{
		labelKey: "hooks.template.eslint",
		draft: {
			...BLANK,
			name: "编辑后 ESLint 检查",
			event: "post_tool",
			tools: "write, edit",
			pattern: String.raw`\.(ts|tsx|js|jsx|mjs|cjs)$`,
			action: "command",
			command: 'npx --no-install eslint "$NEKOCODE_FILE"',
		},
	},
];

function draftOf(hook: HookConfig): Draft {
	return { ...hook, tools: hook.tools.join(", "), timeoutSeconds: String(hook.timeoutMs / 1000) };
}

function toRequest(draft: Draft): SaveHookRequest {
	const { timeoutSeconds, ...rest } = draft;
	return {
		...rest,
		tools: draft.tools.split(/[,，\s]+/).map((tool) => tool.trim()).filter(Boolean),
		timeoutMs: Math.round(Number(timeoutSeconds) * 1000),
	};
}

const OUTCOME_CLASS: Record<HookRunRecord["outcome"], string> = {
	passed: "bg-[var(--success,#16a34a)]",
	blocked: "bg-[var(--warning,#d97706)]",
	failed: "bg-destructive",
	error: "bg-destructive",
};

function baseName(path: string): string {
	const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}

/**
 * The user's own rules around the agent's tool calls: what to refuse before a
 * call runs, and what to run after one lands.
 *
 * Hooks live here, in the app, and are never read from a repository — a hook
 * runs a command, and a repository should not be able to make this machine
 * run one just by being opened.
 */
export function HooksSettings({ projects }: { projects: readonly string[] }) {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<HooksSnapshot | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.hooksList().then(setSnapshot).catch((cause: unknown) => setError(errorMessage(cause)));
		return api.onHooksChanged(setSnapshot);
	}, []);

	const run = (action: Promise<HooksSnapshot>, after?: () => void) => {
		setBusy(true);
		setError(null);
		action
			.then((next) => {
				setSnapshot(next);
				after?.();
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const hooks = snapshot?.hooks ?? [];
	const recent = snapshot?.recent ?? [];
	const problem = draft ? validateHook(toRequest(draft)) : null;
	const needsCommand = draft ? draft.event === "post_tool" || draft.action === "command" : false;
	const projectChoices = [...new Set([...projects, ...(draft?.project ? [draft.project] : [])])];

	return (
		<section className="flex flex-col gap-3">
			<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("hooks.intro")}</p>

			{hooks.length === 0 ? (
				<p className="rounded-lg border border-dashed border-[color:var(--app-surface-divider)] px-3 py-6 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
					{t("hooks.empty")}
				</p>
			) : (
				<div className="flex flex-col gap-2">
					{hooks.map((hook) => (
						<div key={hook.id} className="flex flex-col gap-1 rounded-lg border border-[color:var(--app-surface-divider)] px-3 py-2">
							<div className="flex items-center gap-2">
								<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">{hook.name}</span>
								<span className={CHIP_CLASS_NAME}>
									{t(hook.event === "pre_tool" ? "hooks.event.pre" : "hooks.event.post")}
								</span>
								{hook.event === "pre_tool" ? (
									<span className={CHIP_CLASS_NAME}>
										{t(hook.action === "block" ? "hooks.action.block" : "hooks.action.command")}
									</span>
								) : null}
								<span className="min-w-0 flex-1" />
								<Switch
									checked={hook.enabled}
									disabled={busy}
									onCheckedChange={(checked: boolean) => run(api.hooksSave({ ...hook, enabled: checked }))}
								/>
								<Button disabled={busy} onClick={() => setDraft(draftOf(hook))} size="xs" variant="chrome-outline">
									{t("common.edit")}
								</Button>
								<Button
									aria-label={t("common.delete")}
									disabled={busy}
									onClick={() => run(api.hooksRemove(hook.id))}
									size="icon-xs"
									variant="ghost"
								>
									<TrashCanIcon className="size-3.5" />
								</Button>
							</div>
							<div className="flex flex-wrap items-center gap-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								<span>{hook.tools.length ? hook.tools.join(", ") : t("hooks.allTools")}</span>
								{hook.pattern ? <span className={cn(CHIP_CLASS_NAME, "max-w-full truncate")}>/{hook.pattern}/</span> : null}
								{hook.project ? <span className="truncate">· {baseName(hook.project)}</span> : null}
							</div>
							{hook.action === "command" || hook.event === "post_tool" ? (
								<code className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/80">
									$ {hook.command}
								</code>
							) : null}
						</div>
					))}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<Button onClick={() => setDraft({ ...BLANK })} size="sm" variant="chrome-outline">
					<PlusIcon className="size-3.5" />
					{t("hooks.add")}
				</Button>
				<span className={HINT_CLASS_NAME}>{t("hooks.templates")}</span>
				{TEMPLATES.map((template) => (
					<Button key={template.labelKey} onClick={() => setDraft({ ...template.draft })} size="xs" variant="ghost">
						{t(template.labelKey)}
					</Button>
				))}
			</div>

			{error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null}

			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-2">
					<span className="flex-1 text-[length:var(--app-font-size-ui,12px)] font-medium">{t("hooks.recent")}</span>
					{recent.length ? (
						<Button disabled={busy} onClick={() => run(api.hooksClearRecent())} size="xs" variant="ghost">
							{t("common.clear")}
						</Button>
					) : null}
				</div>
				{recent.length === 0 ? (
					<span className={HINT_CLASS_NAME}>{t("hooks.recentEmpty")}</span>
				) : (
					<div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border border-[color:var(--app-surface-divider)] p-1">
						{recent.map((record, index) => (
							<details key={`${record.at}-${index}`} className="rounded-md px-1.5 py-1 hover:bg-[var(--sidebar-accent)]">
								<summary className="flex cursor-default items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)]">
									<span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", OUTCOME_CLASS[record.outcome])} />
									<span className="shrink-0 text-muted-foreground">{new Date(record.at).toLocaleTimeString()}</span>
									<span className="shrink-0 font-medium">{record.hookName}</span>
									<span className="shrink-0 text-muted-foreground">{t(`hooks.outcome.${record.outcome}` as TranslationKey)}</span>
									<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
										{record.tool}: {record.subject}
									</span>
									<span className="shrink-0 text-muted-foreground/70">{record.durationMs} ms</span>
								</summary>
								{record.output ? (
									<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-background-elevated-secondary)] px-2 py-1 font-mono text-[length:var(--app-font-size-ui-xs,10px)]">
										{record.output}
									</pre>
								) : null}
							</details>
						))}
					</div>
				)}
			</div>

			<p className="flex items-start gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground/70">
				<HammerIcon className="mt-0.5 size-3.5 shrink-0" />
				{t("hooks.footnote")}
			</p>

			{draft ? (
				<SettingsDialog
					title={t(draft.id ? "hooks.editTitle" : "hooks.addTitle")}
					onClose={() => setDraft(null)}
					footer={
						<>
							{problem ? (
								<span className="mr-auto text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
									{t(`hooks.problem.${problem}` as TranslationKey)}
								</span>
							) : null}
							<Button onClick={() => setDraft(null)} size="sm" variant="ghost">
								{t("common.cancel")}
							</Button>
							<Button
								disabled={busy || problem !== null}
								onClick={() => run(api.hooksSave(toRequest(draft)), () => setDraft(null))}
								size="sm"
								variant="subtle"
							>
								{t("common.save")}
							</Button>
						</>
					}
				>
					<div className="flex flex-col gap-1">
						<Label>{t("common.name")}</Label>
						<Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
					</div>

					<div className="flex flex-col gap-1">
						<Label>{t("hooks.field.event")}</Label>
						<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
							{(["pre_tool", "post_tool"] as const).map((event) => (
								<button
									key={event}
									type="button"
									onClick={() => setDraft({ ...draft, event, action: event === "post_tool" ? "command" : draft.action })}
									className={cn(
										"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
										draft.event === event
											? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{t(event === "pre_tool" ? "hooks.event.pre" : "hooks.event.post")}
								</button>
							))}
						</div>
						<span className={HINT_CLASS_NAME}>
							{t(draft.event === "pre_tool" ? "hooks.event.preHint" : "hooks.event.postHint")}
						</span>
					</div>

					<div className="flex flex-col gap-1">
						<Label>{t("hooks.field.tools")}</Label>
						<Input
							className="font-mono"
							placeholder="bash, powershell, write, edit"
							value={draft.tools}
							onChange={(event) => setDraft({ ...draft, tools: event.target.value })}
						/>
						<span className={HINT_CLASS_NAME}>{t("hooks.field.toolsHint")}</span>
					</div>

					<div className="flex flex-col gap-1">
						<Label>{t("hooks.field.pattern")}</Label>
						<Input
							className="font-mono"
							placeholder={String.raw`\brm\s+-rf\b`}
							value={draft.pattern}
							onChange={(event) => setDraft({ ...draft, pattern: event.target.value })}
						/>
						<span className={HINT_CLASS_NAME}>{t("hooks.field.patternHint")}</span>
					</div>

					{draft.event === "pre_tool" ? (
						<div className="flex flex-col gap-1">
							<Label>{t("hooks.field.action")}</Label>
							<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
								{(["block", "command"] as const).map((action) => (
									<button
										key={action}
										type="button"
										onClick={() => setDraft({ ...draft, action })}
										className={cn(
											"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
											draft.action === action
												? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{t(action === "block" ? "hooks.action.block" : "hooks.action.command")}
									</button>
								))}
							</div>
						</div>
					) : null}

					{needsCommand ? (
						<div className="flex flex-col gap-1">
							<Label>{t("hooks.field.command")}</Label>
							<textarea
								className={cn(SETTINGS_TEXTAREA_CLASS_NAME, "min-h-16")}
								placeholder='npx --no-install prettier --write "$NEKOCODE_FILE"'
								spellCheck={false}
								value={draft.command}
								onChange={(event) => setDraft({ ...draft, command: event.target.value })}
							/>
							<span className={HINT_CLASS_NAME}>
								{t(draft.event === "pre_tool" ? "hooks.field.commandPreHint" : "hooks.field.commandPostHint")}
							</span>
						</div>
					) : (
						<div className="flex flex-col gap-1">
							<Label>{t("hooks.field.message")}</Label>
							<Input value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} />
							<span className={HINT_CLASS_NAME}>{t("hooks.field.messageHint")}</span>
						</div>
					)}

					<div className="flex gap-3">
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<Label>{t("hooks.field.project")}</Label>
							<Select
								value={draft.project || ALL_PROJECTS}
								onValueChange={(value) => setDraft({ ...draft, project: !value || value === ALL_PROJECTS ? "" : value })}
							>
								<SelectTrigger size="sm">
									<SelectValue>{draft.project ? baseName(draft.project) : t("hooks.allProjects")}</SelectValue>
								</SelectTrigger>
								<SelectPopup surface="settings">
									<SelectItem value={ALL_PROJECTS}>{t("hooks.allProjects")}</SelectItem>
									{projectChoices.map((path) => (
										<SelectItem key={path} value={path}>
											{baseName(path)} · {path}
										</SelectItem>
									))}
								</SelectPopup>
							</Select>
						</div>
						{needsCommand ? (
							<div className="flex w-28 shrink-0 flex-col gap-1">
								<Label>{t("hooks.field.timeout")}</Label>
								<Input
									inputMode="numeric"
									max={MAX_HOOK_TIMEOUT_MS / 1000}
									min={1}
									type="number"
									value={draft.timeoutSeconds}
									onChange={(event) => setDraft({ ...draft, timeoutSeconds: event.target.value })}
								/>
							</div>
						) : null}
					</div>
				</SettingsDialog>
			) : null}
		</section>
	);
}
