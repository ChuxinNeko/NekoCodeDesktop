// FILE: OnboardingFlow.tsx
// Purpose: First-launch setup — name, working directory, theme, model, preferences.
// Layer: App shell (rendered by main.tsx before <App /> until completed or skipped).

import { AppearanceSettings } from "../settings/AppearanceSettings";
import { useEffect, useMemo, useState } from "react";
import type { ModelApiProtocol } from "../../../../shared/settings";
import { PROTOCOL_DEFAULT_ROUTE } from "../../../../shared/model-protocol";
import type { AppPreferences, CommandShellOption } from "../../../../shared/preferences";
import { api, errorMessage } from "../../api";
import { LANGUAGE_OPTIONS, useTranslation, type TranslationKey } from "../../i18n";
import { useTheme, type ThemeMode } from "../../hooks/useTheme";
import { markOnboarded, readUserName, writeUserName } from "../../lib/onboarding";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, FolderOpenIcon, MoonIcon, SunIcon } from "../../lib/icons";
import { cn, getNavigatorPlatform, isWindowsPlatform } from "../../lib/utils";
import { useHostDirectoryPicker } from "../HostDirectoryPicker";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

const PROJECT_STORAGE_KEY = "nekocode:project-cwd";

const STEPS = ["profile", "workspace", "theme", "models", "preferences"] as const;
type StepId = (typeof STEPS)[number];

const STEP_LABEL: Record<StepId, TranslationKey> = {
	profile: "onboarding.step.profile",
	workspace: "onboarding.step.workspace",
	theme: "onboarding.step.theme",
	models: "onboarding.step.models",
	preferences: "onboarding.step.preferences",
};

const PROTOCOLS: { id: ModelApiProtocol; label: string; placeholder: string }[] = [
	{ id: "openai-completions", label: "OpenAI Chat", placeholder: "https://api.openai.com" },
	{ id: "openai-responses", label: "OpenAI Responses", placeholder: "https://api.openai.com" },
	{ id: "anthropic-messages", label: "Anthropic", placeholder: "https://api.anthropic.com" },
];

interface ModelDraft {
	name: string;
	api: ModelApiProtocol;
	baseUrl: string;
	apiKey: string;
	modelIds: string;
	reasoning: boolean;
}

const EMPTY_MODEL: ModelDraft = { name: "", api: "openai-completions", baseUrl: "", apiKey: "", modelIds: "", reasoning: false };

const COMMAND_SHELL_KEYS: Record<string, TranslationKey> = {
	auto: "settings.commandShell.auto",
	powershell: "settings.commandShell.powershell",
	pwsh: "settings.commandShell.pwsh",
	cmd: "settings.commandShell.cmd",
	"git-bash": "settings.commandShell.gitBash",
	bash: "settings.commandShell.bash",
	zsh: "settings.commandShell.zsh",
	sh: "settings.commandShell.sh",
};

function parseModelIds(text: string): string[] {
	return Array.from(new Set(text.split(/[\s,;，；]+/).map((id) => id.trim()).filter(Boolean)));
}

function modelDraftFilled(draft: ModelDraft): boolean {
	return !!(draft.name.trim() || draft.baseUrl.trim() || draft.apiKey.trim() || draft.modelIds.trim());
}

function modelDraftValid(draft: ModelDraft): boolean {
	return !!draft.name.trim() && /^https?:\/\//i.test(draft.baseUrl.trim()) && parseModelIds(draft.modelIds).length > 0;
}

function shortPath(path: string): string {
	return path.length > 44 ? `…${path.slice(-43)}` : path;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<label className="flex min-w-0 flex-col gap-1.5">
			<span className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">{label}</span>
			{children}
			{hint ? <span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{hint}</span> : null}
		</label>
	);
}

function ToggleRow({ title, hint, checked, onChange, disabled }: {
	title: string;
	hint: string;
	checked: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<div className="flex items-center justify-between gap-6 py-2.5">
			<div className="flex min-w-0 flex-col">
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">{title}</span>
				<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{hint}</span>
			</div>
			<Switch checked={checked} disabled={disabled} onCheckedChange={(value: boolean) => onChange(value)} />
		</div>
	);
}

function StepDot({ state, index }: { state: "done" | "current" | "todo"; index: number }) {
	return (
		<span
			className={cn(
				"flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] leading-none",
				state === "done" && "border-transparent bg-foreground/10 text-foreground",
				state === "current" && "border-foreground bg-background text-foreground",
				state === "todo" && "border-border text-muted-foreground",
			)}
		>
			{state === "done" ? <CheckIcon className="size-2.5" /> : index + 1}
		</span>
	);
}

export function OnboardingFlow({ onDone }: { onDone: () => void }) {
	const { t, language, setLanguage } = useTranslation();
	const { theme, setTheme } = useTheme();
	const pickDirectory = useHostDirectoryPicker();
	const isWindows = isWindowsPlatform(getNavigatorPlatform());

	const [index, setIndex] = useState(0);
	const [name, setName] = useState(readUserName);
	const [cwd, setCwd] = useState<string | null>(null);
	const [model, setModel] = useState<ModelDraft>(EMPTY_MODEL);
	const [savedModel, setSavedModel] = useState<string | null>(null);
	const [preferences, setPreferences] = useState<AppPreferences | null>(null);
	const [shells, setShells] = useState<CommandShellOption[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.preferencesGet().then(setPreferences).catch(() => undefined);
		api.preferencesCommandShells().then(setShells).catch(() => undefined);
	}, []);

	const step = STEPS[index]!;
	const last = index === STEPS.length - 1;
	const trimmedName = name.trim();
	const defaultDir = api.homeDir || null;

	const setPreference = (patch: Partial<AppPreferences>) => {
		setPreferences((current) => (current ? { ...current, ...patch } : current));
		api.preferencesUpdate(patch).then(setPreferences).catch((cause: unknown) => setError(errorMessage(cause)));
	};

	const finish = () => {
		writeUserName(name);
		if (cwd) {
			try { localStorage.setItem(PROJECT_STORAGE_KEY, cwd); } catch { /* not persisted */ }
		}
		markOnboarded();
		onDone();
	};

	const skipAll = () => {
		markOnboarded();
		onDone();
	};

	const choose = async () => {
		try {
			const picked = await pickDirectory(cwd ?? defaultDir ?? undefined);
			if (picked) setCwd(picked);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	/** Saves the model form when it was filled in; an untouched form is a skip. */
	const saveModel = async (): Promise<boolean> => {
		if (!modelDraftFilled(model) || savedModel) return true;
		if (!modelDraftValid(model)) {
			setError(t("onboarding.models.invalid"));
			return false;
		}
		setBusy(true);
		setError(null);
		try {
			const saved = await api.modelSave({
				kind: "custom-api",
				name: model.name.trim(),
				baseUrl: model.baseUrl.trim().replace(/\/+$/, ""),
				route: PROTOCOL_DEFAULT_ROUTE[model.api],
				api: model.api,
				apiKey: model.apiKey.trim() || undefined,
				modelIds: parseModelIds(model.modelIds),
				reasoning: model.reasoning,
			});
			setSavedModel(saved.name);
			return true;
		} catch (cause) {
			setError(errorMessage(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const next = async () => {
		setError(null);
		if (step === "models" && !(await saveModel())) return;
		if (last) finish();
		else setIndex((value) => value + 1);
	};

	const back = () => {
		setError(null);
		setIndex((value) => Math.max(0, value - 1));
	};

	const skipStep = () => {
		setError(null);
		if (last) finish();
		else setIndex((value) => value + 1);
	};

	const summaries: Record<StepId, string> = useMemo(() => ({
		profile: trimmedName || t("onboarding.skipped"),
		workspace: cwd ? shortPath(cwd) : defaultDir ? t("onboarding.workspace.home") : t("onboarding.skipped"),
		theme: t(`onboarding.theme.${theme}` as TranslationKey),
		models: savedModel ?? t("onboarding.skipped"),
		preferences: t("onboarding.preferences.summary"),
	}), [trimmedName, cwd, defaultDir, theme, savedModel, t]);

	const themeOptions: { id: ThemeMode; icon: React.ReactNode }[] = [
		{ id: "light", icon: <SunIcon className="size-4" /> },
		{ id: "dark", icon: <MoonIcon className="size-4" /> },
		{ id: "system", icon: <span className="flex size-4 items-center justify-center text-[11px]">◐</span> },
	];

	const inputClass = "h-9";

	return (
		<div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
			<div className="app-titlebar h-9 shrink-0" />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto grid w-full max-w-[1000px] grid-cols-1 gap-8 px-8 pb-10 pt-4 lg:grid-cols-[minmax(0,640px)_minmax(0,260px)] lg:gap-12">
					<div className="min-w-0">
						<p className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
							{t("onboarding.stepOf", { current: index + 1, total: STEPS.length })}
						</p>
						<h1 className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.02em]">
							{trimmedName ? t("onboarding.titleNamed", { name: trimmedName }) : t("onboarding.title")}
						</h1>
						<p className="mt-1.5 text-[length:var(--app-font-size-chat-body,13px)] text-muted-foreground">
							{t("onboarding.subtitle")}
						</p>

						<ol className="mt-5 flex items-center" aria-label={t("onboarding.checklist")}>
							{STEPS.map((id, i) => {
								const state = i < index ? "done" : i === index ? "current" : "todo";
								return (
									<li key={id} className={cn("flex items-center", i < STEPS.length - 1 && "flex-1")}>
										<button
											type="button"
											disabled={i > index}
											onClick={() => { setError(null); setIndex(i); }}
											className={cn(
												"flex items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)] disabled:cursor-default",
												state === "current" ? "font-medium text-foreground" : "text-muted-foreground",
											)}
										>
											<StepDot state={state} index={i} />
											{t(STEP_LABEL[id])}
										</button>
										{i < STEPS.length - 1 ? <span className="mx-3 h-px flex-1 bg-border" /> : null}
									</li>
								);
							})}
						</ol>

						<div className="mt-5 rounded-[26px] bg-secondary/60 p-1.5">
							<section className="min-h-[340px] rounded-[20px] border border-border/70 bg-card px-7 py-6 shadow-sm">
								{step === "profile" ? (
									<div className="flex flex-col gap-5">
										<Heading title={t("onboarding.profile.title")} hint={t("onboarding.profile.hint")} />
										<Field label={t("onboarding.profile.name")}>
											<Input
												autoFocus
												className={inputClass}
												value={name}
												maxLength={40}
												placeholder={t("onboarding.profile.namePlaceholder")}
												onChange={(event) => setName(event.target.value)}
											/>
										</Field>
										<Field label={t("settings.language")}>
											<div className="flex w-fit items-center gap-1 rounded-lg bg-secondary p-0.5">
												{LANGUAGE_OPTIONS.map((entry) => (
													<button
														key={entry.id}
														type="button"
														onClick={() => setLanguage(entry.id)}
														className={cn(
															"rounded-md px-3 py-1 text-[length:var(--app-font-size-ui,12px)] transition-colors",
															language === entry.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
														)}
													>
														{entry.label}
													</button>
												))}
											</div>
										</Field>
									</div>
								) : null}

								{step === "workspace" ? (
									<div className="flex flex-col gap-5">
										<Heading title={t("onboarding.workspace.title")} hint={t("onboarding.workspace.hint")} />
										<button
											type="button"
											onClick={() => void choose()}
											className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-4 text-left transition-colors hover:bg-secondary/60"
										>
											<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
												<FolderOpenIcon className="size-4" />
											</span>
											<span className="flex min-w-0 flex-col">
												<span className="truncate text-[length:var(--app-font-size-chat-body,13px)] font-medium" title={cwd ?? undefined}>
													{cwd ?? t("onboarding.workspace.choose")}
												</span>
												<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
													{cwd ? t("onboarding.workspace.change") : t("onboarding.workspace.default", { path: defaultDir ?? "~" })}
												</span>
											</span>
										</button>
									</div>
								) : null}

								{step === "theme" ? (
									<div className="flex flex-col gap-5">
										<Heading title={t("onboarding.theme.title")} hint={t("onboarding.theme.hint")} />
										<div className="grid grid-cols-3 gap-3">
											{themeOptions.map((option) => (
												<button
													key={option.id}
													type="button"
													onClick={() => setTheme(option.id)}
													aria-pressed={theme === option.id}
													className={cn(
														"flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
														theme === option.id ? "border-foreground" : "border-border hover:bg-secondary/60",
													)}
												>
													<ThemePreview mode={option.id} />
													<span className="flex items-center gap-1.5 px-1 pb-0.5 text-[length:var(--app-font-size-ui,12px)] font-medium">
														{option.icon}
														{t(`onboarding.theme.${option.id}` as TranslationKey)}
													</span>
												</button>
											))}
										</div>
										<AppearanceSettings embedded />
									</div>
								) : null}

								{step === "models" ? (
									<div className="flex flex-col gap-4">
										<Heading title={t("onboarding.models.title")} hint={t("onboarding.models.hint")} />
										{savedModel ? (
											<p className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-[length:var(--app-font-size-ui,12px)]">
												<CheckIcon className="size-3.5" />
												{t("onboarding.models.saved", { name: savedModel })}
											</p>
										) : (
											<>
												<div className="grid grid-cols-2 gap-3">
													<Field label={t("onboarding.models.name")}>
														<Input className={inputClass} value={model.name} placeholder="My provider" onChange={(e) => setModel({ ...model, name: e.target.value })} />
													</Field>
													<Field label={t("onboarding.models.protocol")}>
														<div className="flex h-9 items-center gap-0.5 rounded-lg bg-secondary p-0.5">
															{PROTOCOLS.map((protocol) => (
																<button
																	key={protocol.id}
																	type="button"
																	onClick={() => setModel({ ...model, api: protocol.id })}
																	className={cn(
																		"h-full flex-1 truncate rounded-md px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
																		model.api === protocol.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
																	)}
																>
																	{protocol.label}
																</button>
															))}
														</div>
													</Field>
												</div>
												<Field label={t("onboarding.models.baseUrl")}>
													<Input className={cn(inputClass, "font-mono")} value={model.baseUrl} placeholder={PROTOCOLS.find((p) => p.id === model.api)?.placeholder} onChange={(e) => setModel({ ...model, baseUrl: e.target.value })} />
												</Field>
												<div className="grid grid-cols-2 gap-3">
													<Field label={t("onboarding.models.apiKey")}>
														<Input className={cn(inputClass, "font-mono")} type="password" autoComplete="off" value={model.apiKey} placeholder="sk-…" onChange={(e) => setModel({ ...model, apiKey: e.target.value })} />
													</Field>
													<Field label={t("onboarding.models.modelIds")}>
														<Input className={cn(inputClass, "font-mono")} value={model.modelIds} placeholder="gpt-4.1, o4-mini" onChange={(e) => setModel({ ...model, modelIds: e.target.value })} />
													</Field>
												</div>
												<ToggleRow
													title={t("onboarding.models.reasoning")}
													hint={t("onboarding.models.reasoningHint")}
													checked={model.reasoning}
													onChange={(reasoning) => setModel({ ...model, reasoning })}
												/>
											</>
										)}
									</div>
								) : null}

								{step === "preferences" ? (
									<div className="flex flex-col gap-1">
										<Heading title={t("onboarding.preferences.title")} hint={t("onboarding.preferences.hint")} />
										<div className="mt-3 flex flex-col divide-y divide-border/60">
											<ToggleRow
												title={t("settings.notifyOnTaskFinish")}
												hint={t("settings.notifyOnTaskFinishHint")}
												checked={preferences?.notifyOnTaskFinish ?? false}
												disabled={!preferences}
												onChange={(notifyOnTaskFinish) => setPreference({ notifyOnTaskFinish })}
											/>
											<ToggleRow
												title={t("settings.isolateBackground")}
												hint={t("settings.isolateBackgroundHint")}
												checked={preferences?.isolateBackgroundTasks ?? false}
												disabled={!preferences}
												onChange={(isolateBackgroundTasks) => setPreference({ isolateBackgroundTasks })}
											/>
											{isWindows ? (
												<ToggleRow
													title={t("settings.computerUse")}
													hint={t("settings.computerUseHint")}
													checked={preferences?.computerUse ?? false}
													disabled={!preferences}
													onChange={(computerUse) => setPreference({ computerUse })}
												/>
											) : null}
											<div className="flex flex-col gap-2 py-2.5">
												<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("settings.commandShell")}</span>
												<div className="flex flex-wrap gap-1.5">
													{shells.map((shell) => {
														const unavailable = shell.id !== "auto" && !shell.path;
														return (
															<button
																key={shell.id}
																type="button"
																disabled={unavailable || !preferences}
																onClick={() => setPreference({ commandShell: shell.id })}
																className={cn(
																	"rounded-full border px-3 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
																	preferences?.commandShell === shell.id ? "border-foreground bg-foreground text-background" : "border-border hover:bg-secondary/60",
																)}
															>
																{t(COMMAND_SHELL_KEYS[shell.id] ?? "settings.commandShell.auto")}
															</button>
														);
													})}
												</div>
											</div>
										</div>
									</div>
								) : null}

								{error ? <p className="mt-4 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}
							</section>

							<div className="sticky bottom-0 z-10 -mx-1.5 -mb-1.5 flex items-center justify-between rounded-b-[26px] bg-background px-[18px] py-2.5 [background-image:linear-gradient(color-mix(in_srgb,var(--secondary)_60%,transparent),color-mix(in_srgb,var(--secondary)_60%,transparent))]">
								<button
									type="button"
									onClick={step === "models" || step === "workspace" ? skipStep : skipAll}
									className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground transition-colors hover:text-foreground"
								>
									{step === "models" || step === "workspace" ? t("onboarding.skipStep") : t("onboarding.skipAll")}
								</button>
								<div className="flex items-center gap-2">
									{index > 0 ? (
										<button
											type="button"
											onClick={back}
											className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-[length:var(--app-font-size-ui,12px)] font-medium transition-colors hover:bg-secondary/60"
										>
											<ArrowLeftIcon className="size-3.5" />
											{t("onboarding.back")}
										</button>
									) : null}
									<button
										type="button"
										disabled={busy}
										onClick={() => void next()}
										className="flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[length:var(--app-font-size-ui,12px)] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
									>
										{last ? t("onboarding.finish") : t("onboarding.continue")}
										<ArrowRightIcon className="size-3.5" />
									</button>
								</div>
							</div>
						</div>
					</div>

					<aside className="flex min-w-0 flex-col gap-4 lg:pt-[150px]">
						<div className="rounded-2xl border border-border/70 bg-secondary/30 p-4">
							<div className="flex items-center justify-between text-[length:var(--app-font-size-ui,12px)] font-medium">
								<span>{t("onboarding.checklist")}</span>
								<span><span className="text-foreground">{index}</span><span className="text-muted-foreground">/{STEPS.length}</span></span>
							</div>
							<div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-border">
								<div className="h-full rounded-full bg-foreground transition-[width] duration-300" style={{ width: `${(index / STEPS.length) * 100}%` }} />
							</div>
							<ul className="mt-3 flex flex-col gap-0.5">
								{STEPS.map((id, i) => {
									const state = i < index ? "done" : i === index ? "current" : "todo";
									return (
										<li
											key={id}
											className={cn(
												"flex items-start gap-2.5 rounded-xl border px-2.5 py-2",
												state === "current" ? "border-border bg-card shadow-sm" : "border-transparent",
											)}
										>
											<span
												className={cn(
													"mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border",
													state === "done" && "border-foreground bg-foreground text-background",
													state === "current" && "border-foreground",
													state === "todo" && "border-border",
												)}
											>
												{state === "done" ? <CheckIcon className="size-2.5" /> : null}
											</span>
											<span className="flex min-w-0 flex-col">
												<span className={cn("text-[length:var(--app-font-size-ui,12px)]", state === "todo" ? "text-muted-foreground" : "font-medium text-foreground")}>
													{t(STEP_LABEL[id])}
												</span>
												<span className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
													{state === "done" ? summaries[id] : state === "current" ? t("onboarding.inProgress") : t("onboarding.todo")}
												</span>
											</span>
										</li>
									);
								})}
							</ul>
						</div>
						<div className="flex items-start gap-3 px-2">
							<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-[13px]">⚙</span>
							<span className="flex flex-col">
								<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("onboarding.later.title")}</span>
								<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("onboarding.later.hint")}</span>
							</span>
						</div>
					</aside>
				</div>
			</div>
		</div>
	);
}

function Heading({ title, hint }: { title: string; hint: string }) {
	return (
		<div>
			<h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
			<p className="mt-1 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">{hint}</p>
		</div>
	);
}

/** A miniature window in the mode's colours; "system" splits it down the middle. */
function ThemePreview({ mode }: { mode: ThemeMode }) {
	const pane = (dark: boolean) => (
		<div className={cn("flex h-full flex-1 flex-col gap-1 p-1.5", dark ? "bg-[#161616]" : "bg-[#fafaf9]")}>
			<span className={cn("h-1.5 w-8 rounded-full", dark ? "bg-white/70" : "bg-black/70")} />
			<span className={cn("h-1.5 w-12 rounded-full", dark ? "bg-white/25" : "bg-black/20")} />
		</div>
	);
	return (
		<div className="flex h-[68px] overflow-hidden rounded-lg border border-border/70">
			{mode === "system" ? <>{pane(false)}{pane(true)}</> : pane(mode === "dark")}
		</div>
	);
}
