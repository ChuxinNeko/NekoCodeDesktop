import iconSnapshot from "../../lib/acp-provider-icons.json";
import { useEffect, useState } from "react";
import type { AcpAgentInfo, AcpProviderProfile, AcpProviderState } from "../../../../shared/acp";
import {
	ACP_PRESET_GROUPS, ACP_PROVIDER_PRESETS, getAcpProviderState, isRecord,
	parseProviderConfig, presetGroup, presetLimitation, presetMatches, profileFromPreset,
	providerFields, serializeProviderConfig, updateProviderFields,
	type AcpPresetGroup, type AcpProviderFields, type AcpProviderPreset,
} from "../../../../shared/acp-providers";
import { formatKeyValueLines, parseKeyValueLines } from "../../../../shared/mcp";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { PlusIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopupBase, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { SettingsDialog } from "./SettingsDialog";

const muted = "text-xs leading-relaxed text-muted-foreground";
const border = "border-[color:var(--app-surface-divider)]";
const newId = () => crypto.randomUUID();

const providerIconUrls: Record<string, string> = (() => {
	try {
		return import.meta.glob("../../assets/cc-switch-providers/*", { eager: true, query: "?url", import: "default" });
	} catch {
		// Server-rendered tests have no Vite asset loader.
		return {};
	}
})();
const providerIcons = iconSnapshot as Record<string, { svg?: string; src?: string; tile?: boolean }>;
function ProviderMark({ name, color, icon }: { name: string; color?: string; icon?: string }) {
	const asset = icon ? providerIcons[icon] : undefined;
	return <span aria-hidden="true" style={color ? { color } : undefined} className={cn("flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-[var(--color-background-elevated-secondary)] text-sm font-semibold [&_svg]:size-5", border)}>
		{asset?.src ? <img src={providerIconUrls[`../../assets/cc-switch-providers/${asset.src}`]} alt="" className={asset.tile ? "size-full object-cover" : "size-5 object-contain"} />
			: asset?.svg ? <span className="flex items-center justify-center" dangerouslySetInnerHTML={{ __html: asset.svg }} />
				: name.slice(0, 1).toUpperCase()}
	</span>;
}

export function AcpProviderList({ agentId, state, query, busy, onActivate, onEdit, onDuplicate, onDelete, onMove }: {
	agentId: string; state: AcpProviderState; query: string; busy: boolean;
	onActivate: (profile: AcpProviderProfile) => void; onEdit: (profile: AcpProviderProfile) => void;
	onDuplicate: (profile: AcpProviderProfile) => void; onDelete: (profile: AcpProviderProfile) => void;
	onMove: (profile: AcpProviderProfile, offset: number) => void;
}) {
	const { t } = useTranslation();
	const profiles = state.profiles.filter((profile) => `${profile.name} ${profile.notes} ${profile.websiteUrl}`.toLowerCase().includes(query.toLowerCase()));
	return <div className="flex flex-col gap-2">
		{profiles.map((profile) => {
			const active = state.activeId === profile.id;
			const index = state.profiles.indexOf(profile);
			let endpoint = "";
			try { endpoint = providerFields(agentId, profile).baseUrl; } catch { /* A malformed draft never blocks the saved list. */ }
			return <article key={profile.id} className={cn("flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 transition-colors", active ? "border-primary/40 bg-primary/5" : border)}>
				<ProviderMark name={profile.name} icon={ACP_PROVIDER_PRESETS[agentId as "codex" | "claude"]?.find((entry) => entry.id === profile.presetId)?.icon} />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{profile.name}</span>
						<span className="rounded-md bg-[var(--color-background-elevated-secondary)] px-1.5 py-0.5 text-[10px] text-muted-foreground">{profile.category === "current" ? t("acpProviders.imported") : t(`acpProviders.group.${presetGroup(profile)}`)}</span>
					</div>
					<p className={cn(muted, "truncate")}>{profile.notes || endpoint || profile.websiteUrl || t("acpProviders.configured")}</p>
				</div>
				<div className="flex items-center gap-2">
					{active ? <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium"><span className="size-1.5 rounded-full bg-green-500" />{t("acpProviders.enabled")}</span> : <Button size="xs" variant="chrome-outline" disabled={busy} onClick={() => onActivate(profile)}>{t("acpProviders.enable")}</Button>}
					<Button size="xs" variant="ghost" disabled={busy} onClick={() => onEdit(profile)} aria-label={`${t("common.edit")} ${profile.name}`}>{t("common.edit")}</Button>
					<Menu><MenuTrigger disabled={busy} aria-label={`${t("acpProviders.more")} ${profile.name}`} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent">···</MenuTrigger>
						<MenuPopupBase align="end">
							<MenuItem onClick={() => onDuplicate(profile)}>{t("acpProviders.duplicate")}</MenuItem>
							<MenuItem disabled={index === 0} onClick={() => onMove(profile, -1)}>{t("acpProviders.moveUp")}</MenuItem>
							<MenuItem disabled={index === state.profiles.length - 1} onClick={() => onMove(profile, 1)}>{t("acpProviders.moveDown")}</MenuItem>
							<MenuSeparator />
							<MenuItem disabled={active} title={active ? t("acpProviders.deleteActive") : undefined} className="text-destructive" onClick={() => onDelete(profile)}>{t("acpProviders.delete")}</MenuItem>
						</MenuPopupBase>
					</Menu>
				</div>
			</article>;
		})}
		{!profiles.length ? <p className={cn(muted, "py-12 text-center")}>{t("acpProviders.noResults")}</p> : null}
	</div>;
}

export function AcpPresetPicker({ agentId, onPick }: { agentId: string; onPick: (preset?: AcpProviderPreset) => void }) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [group, setGroup] = useState<"all" | AcpPresetGroup>("all");
	const presets = ACP_PROVIDER_PRESETS[agentId as "codex" | "claude"] ?? [];
	const matching = presets.filter((preset) => presetMatches(preset, query));
	const rows = new Map<string, AcpProviderPreset[]>();
	for (const preset of matching) {
		const key = preset.family ?? preset.id;
		rows.set(key, [...(rows.get(key) ?? []), preset]);
	}
	const grouped = [...rows.values()].sort((a, b) => (a[0].familyName ?? a[0].name).localeCompare(b[0].familyName ?? b[0].name));
	const groups = group === "all" ? ACP_PRESET_GROUPS : [group];
	return <div className="flex flex-col gap-4" data-acp-preset-picker>
		<Input autoFocus aria-label={t("acpProviders.searchPresets")} placeholder={t("acpProviders.searchPresets")} value={query} onChange={(event) => setQuery(event.target.value)} />
		<div className="flex min-h-[24rem] gap-4">
			<nav aria-label={t("acpProviders.categories")} className="flex w-28 shrink-0 flex-col gap-1 sm:w-36">
				{(["all", ...ACP_PRESET_GROUPS] as const).map((entry) => {
					const count = grouped.filter((versions) => entry === "all" || presetGroup(versions[0]) === entry).length;
					return <button type="button" key={entry} aria-pressed={group === entry} onClick={() => setGroup(entry)} className={cn("flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs", group === entry ? "bg-[var(--color-background-elevated-secondary)] text-foreground" : "text-muted-foreground hover:bg-accent")}><span>{t(`acpProviders.group.${entry}`)}</span><span>{count}</span></button>;
				})}
			</nav>
			<div className="flex min-w-0 flex-1 flex-col gap-5">
				<button type="button" onClick={() => onPick()} className={cn("flex items-center gap-3 rounded-xl border p-3 text-left hover:bg-accent", border)}><ProviderMark name="+" /><div><p className="text-xs font-medium">{t("acpProviders.custom")}</p><p className={muted}>{t("acpProviders.customHint")}</p></div></button>
				{groups.map((section) => {
					const entries = grouped.filter((versions) => presetGroup(versions[0]) === section);
					if (!entries.length) return null;
					return <section className="flex flex-col gap-2" key={section}><h3 className={muted}>{t(`acpProviders.group.${section}`)}</h3>
						<div className="grid gap-2 min-[1000px]:grid-cols-2">{entries.map((versions) => {
							const preset = versions[0];
							const limitation = presetLimitation(agentId, preset);
							return <button key={preset.family ?? preset.id} type="button" onClick={() => onPick(preset)} className={cn("flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent", border)}>
								<ProviderMark name={preset.familyName ?? preset.name} color={preset.iconColor} icon={preset.icon} />
								<div className="min-w-0"><p className="truncate text-xs font-medium">{preset.familyName ?? preset.name}</p><p className={cn(muted, "truncate")}>{versions.length > 1 ? t("acpProviders.versions", { count: versions.length }) : preset.websiteUrl.replace(/^https?:\/\//, "").split("/")[0]}</p>
									{limitation ? <span className="text-[10px] text-[var(--warning)]">{t(`acpProviders.${limitation}Badge`)}</span> : null}
								</div>
							</button>;
						})}</div>
					</section>;
				})}
				{!grouped.length && query ? <p className={muted}>{t("acpProviders.noResults")}</p> : null}
			</div>
		</div>
	</div>;
}

export function AcpProviderForm({ agentId, initial, preset, editing, busy, onChangePreset, onSave, onCancel }: {
	agentId: string; initial: AcpProviderProfile; preset?: AcpProviderPreset; editing: boolean; busy: boolean;
	onChangePreset: () => void; onSave: (profile: AcpProviderProfile) => Promise<void>; onCancel: () => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState(initial);
	const [envText, setEnvText] = useState(formatKeyValueLines(initial.env));
	const selectedPreset = ACP_PROVIDER_PRESETS[agentId as "codex" | "claude"]?.find((entry) => entry.id === draft.presetId) ?? preset;
	const [dirty, setDirty] = useState(false);
	const [pendingPreset, setPendingPreset] = useState<AcpProviderPreset | null>(null);
	const applyPreset = (selected: AcpProviderPreset) => { setDraft(profileFromPreset(agentId, selected)); setModels(selected.modelCatalog?.map((entry) => entry.model) ?? []); setEnvText(""); setDirty(false); setError(null); };
	const [showKey, setShowKey] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fetching, setFetching] = useState(false);
	const [models, setModels] = useState<string[]>(selectedPreset?.modelCatalog?.map((entry) => entry.model) ?? []);
	const supported = agentId === "codex" || agentId === "claude";
	const official = draft.category === "official";
	const imported = draft.category === "current";
	const limitation = selectedPreset ? presetLimitation(agentId, selectedPreset) : null;
	let fields: AcpProviderFields | null = null;
	let configError: string | null = null;
	try { fields = providerFields(agentId, draft); } catch (cause) { configError = errorMessage(cause); }
	const update = (patch: Partial<AcpProviderFields> & { apiKey?: string }) => {
		try { setDraft(updateProviderFields(agentId, draft, patch)); setDirty(true); setError(null); }
		catch (cause) { setError(errorMessage(cause)); }
	};
	const field = (key: keyof AcpProviderFields, label: string, placeholder = "") => <label className="flex min-w-0 flex-col gap-1.5 text-xs">{label}<Input disabled={!fields || busy} value={fields?.[key] ?? ""} placeholder={placeholder} onChange={(event) => update({ [key]: event.target.value })} list={key === "model" || key === "haiku" || key === "sonnet" || key === "opus" || key === "subagent" ? "acp-provider-models" : undefined} /></label>;
	const fetchModels = async () => {
		if (!fields) return;
		setFetching(true); setError(null);
		try {
			const baseUrl = fields.baseUrl.replace(/\/+$/, "");
			const apiProtocol = agentId === "codex" ? "openai-responses" as const : "anthropic-messages" as const;
			const route = agentId === "codex" ? "/responses" : baseUrl.endsWith("/v1") ? "/messages" : "/v1/messages";
			const fetched = await api.modelFetch({ baseUrl, route, api: apiProtocol, apiKey: draft.apiKey });
			setModels(fetched.map((entry) => entry.id));
			if (!fetched.length) setError(t("acpProviders.noModels"));
		} catch (cause) { setError(errorMessage(cause)); }
		finally { setFetching(false); }
	};
	const submit = async (event: React.FormEvent) => {
		event.preventDefault(); setError(null);
		try { await onSave({ ...draft, env: parseKeyValueLines(envText) }); } catch (cause) { setError(errorMessage(cause)); }
	};
	return <form onChangeCapture={(event) => { if (!(event.target as HTMLElement).closest("[data-acp-preset-version]")) setDirty(true); }} onSubmit={(event) => void submit(event)} className="flex flex-col gap-5" data-acp-provider-form>
		{!editing ? <div className="flex items-center gap-3 rounded-xl bg-[var(--color-background-elevated-secondary)] p-3">
			<ProviderMark name={selectedPreset?.familyName ?? selectedPreset?.name ?? "+"} color={selectedPreset?.iconColor} icon={selectedPreset?.icon} />
			<div className="min-w-0 flex-1"><p className="text-xs font-medium">{selectedPreset?.familyName ?? selectedPreset?.name ?? t("acpProviders.custom")}</p><p className={cn(muted, "truncate")}>{selectedPreset?.websiteUrl}</p></div>
			<Button size="xs" variant="ghost" disabled={busy} onClick={onChangePreset}>{t("acpProviders.change")}</Button>
		</div> : null}
		{!editing && selectedPreset?.family ? <label className="flex flex-col gap-1.5 text-xs">{t("acpProviders.version")}
			<select className={cn("rounded-lg border bg-background px-3 py-2 text-xs", border)} data-acp-preset-version value={selectedPreset.id} disabled={busy} onChange={(event) => {
				const selected = ACP_PROVIDER_PRESETS[agentId as "codex" | "claude"].find((entry) => entry.id === event.target.value);
				if (selected) { if (dirty) setPendingPreset(selected); else applyPreset(selected); }
			}}>{ACP_PROVIDER_PRESETS[agentId as "codex" | "claude"].filter((entry) => entry.family === selectedPreset.family).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
		</label> : null}
		<fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="flex flex-col gap-1.5 text-xs">{t("acpProviders.name")} *<Input autoFocus required value={draft.name} placeholder={t("acpProviders.namePlaceholder")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
				<label className="flex flex-col gap-1.5 text-xs">{t("acpProviders.notes")}<Input value={draft.notes} placeholder={t("acpProviders.notesPlaceholder")} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
			</div>
			<label className="flex flex-col gap-1.5 text-xs">{t("acpProviders.website")}<Input value={draft.websiteUrl} placeholder="https://example.com" onChange={(event) => setDraft({ ...draft, websiteUrl: event.target.value })} /></label>
			{official ? <div className={cn("rounded-xl border p-4", border)}><p className="text-xs font-medium">{t("acpProviders.officialLogin")}</p><p className={cn(muted, "mt-1")}>{t("acpProviders.officialHint", { command: agentId === "codex" ? "codex login" : "claude" })}</p></div> : supported && !imported ? <>
				<div className={cn("flex flex-col gap-4 border-t pt-4", border)}>
					<p className="text-xs font-medium">{t("acpProviders.connection")}</p>
					<label className="flex flex-col gap-1.5 text-xs">API Key<div className="flex gap-2"><Input type={showKey ? "text" : "password"} autoComplete="off" value={draft.apiKey} onChange={(event) => update({ apiKey: event.target.value })} placeholder="sk-…" /><Button size="sm" variant="ghost" aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{t(showKey ? "acpProviders.hideKey" : "acpProviders.showKey")}</Button></div></label>
					{agentId === "claude" ? <label className="flex flex-col gap-1.5 text-xs">{t("acpProviders.authField")}<select className={cn("rounded-lg border bg-background px-3 py-2", border)} value={fields?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"} onChange={(event) => update({ apiKeyField: event.target.value })}><option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN</option><option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option></select></label> : null}
					{field("baseUrl", t("acpProviders.endpoint"), agentId === "codex" ? "https://api.example.com/v1" : "https://api.example.com")}
					{selectedPreset?.endpointCandidates?.length ? <div className="flex flex-wrap gap-1">{selectedPreset.endpointCandidates.map((url) => <Button size="xs" variant="ghost" key={url} onClick={() => update({ baseUrl: url })}>{url}</Button>)}</div> : null}
					<p className={muted}>{agentId === "codex" ? "OpenAI Responses API" : "Anthropic Messages API"}</p>
				</div>
				<div className={cn("flex flex-col gap-3 border-t pt-4", border)}>
					<div className="flex items-center justify-between"><span className="text-xs font-medium">{t("acpProviders.models")}</span><Button size="xs" variant="chrome-outline" disabled={fetching || !fields?.baseUrl || !draft.apiKey} onClick={() => void fetchModels()}>{fetching ? <Spinner className="size-3" /> : null}{t("acpProviders.fetchModels")}</Button></div>
					{field("model", t("acpProviders.defaultModel"), t("acpProviders.modelPlaceholder"))}
					{models.length ? <select aria-label={t("acpProviders.fetchedModels")} className={cn("rounded-lg border bg-background px-3 py-2 text-xs", border)} value="" onChange={(event) => { if (event.target.value) update({ model: event.target.value }); }}><option value="">{t("acpProviders.fetchedModels")}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select> : null}
					<datalist id="acp-provider-models">{models.map((model) => <option key={model} value={model} />)}</datalist>
					{agentId === "claude" ? <div className="grid gap-3 sm:grid-cols-2">{field("haiku", "Haiku")}{field("sonnet", "Sonnet")}{field("opus", "Opus")}{field("subagent", t("acpProviders.subagent"))}</div> : <label className="flex flex-col gap-1.5 text-xs">{t("acpModels.reasoning")}<select className={cn("rounded-lg border bg-background px-3 py-2", border)} value={fields?.reasoning ?? ""} onChange={(event) => update({ reasoning: event.target.value })}>{["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((entry) => <option key={entry} value={entry}>{entry || t("acpModels.defaultModel")}</option>)}</select></label>}
				</div>
			</> : null}
			<details className={cn("rounded-xl border p-3", border)} open={imported || !supported || !!configError}>
				<summary className="cursor-pointer text-xs font-medium">{t("acpProviders.advanced")}</summary>
				<div className="mt-4 flex flex-col gap-3">
					<label className="flex flex-col gap-1.5 text-xs">{agentId === "codex" ? "config.toml" : "settings.json"}<Textarea spellCheck={false} className="min-h-56 font-mono text-xs" value={draft.config} onChange={(event) => {
						const config = event.target.value;
						let apiKey = draft.apiKey;
						if (agentId === "claude") {
							try { const parsed = parseProviderConfig(agentId, config); if (isRecord(parsed.env)) apiKey = String(parsed.env.ANTHROPIC_API_KEY ?? parsed.env.ANTHROPIC_AUTH_TOKEN ?? ""); } catch { /* Incomplete typing stays editable. */ }
						}
						setDraft({ ...draft, config, apiKey });
					}} /></label>
					<Button size="xs" variant="ghost" className="self-start" disabled={!!configError} onClick={() => setDraft({ ...draft, config: serializeProviderConfig(agentId, parseProviderConfig(agentId, draft.config)) })}>{t("acpProviders.format")}</Button>
					<label className="flex flex-col gap-1.5 text-xs">{t("acpSettings.env")}<Textarea spellCheck={false} className="min-h-20 font-mono text-xs" value={envText} onChange={(event) => setEnvText(event.target.value)} /></label>
				</div>
			</details>
		</fieldset>
		{limitation ? <p role="alert" className="text-xs text-[var(--warning)]">{t(`acpProviders.${limitation}Hint`)}</p> : null}
		{configError || error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{configError || error}</p> : null}
		<div className={cn("sticky bottom-0 flex justify-end gap-2 border-t bg-background py-3", border)}>
			<Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
			<Button variant="subtle" size="sm" type="submit" disabled={busy || fetching || !draft.name.trim() || !!configError || !!limitation}>{busy ? <Spinner className="size-3" /> : null}{t(editing ? "common.save" : "acpProviders.add")}</Button>
		</div>
		<ConfirmDialog open={!!pendingPreset} onOpenChange={(open) => { if (!open) setPendingPreset(null); }} title={t("acpProviders.switchVersionTitle")} description={t("acpProviders.switchVersionHint")}
			footer={<><Button size="sm" variant="ghost" onClick={() => setPendingPreset(null)}>{t("common.cancel")}</Button><Button size="sm" variant="subtle" onClick={() => { if (pendingPreset) applyPreset(pendingPreset); setPendingPreset(null); }}>{t("acpProviders.change")}</Button></>} />
	</form>;
}

/** CC Switch-style saved provider list with a two-step add/edit dialog. */
export function AcpModelSettings({ agent }: { agent: AcpAgentInfo }) {
	const { t } = useTranslation();
	const [state, setState] = useState(() => getAcpProviderState(agent));
	const [query, setQuery] = useState("");
	const [page, setPage] = useState<"list" | "pick" | "form">("list");
	const [draft, setDraft] = useState<AcpProviderProfile | null>(null);
	const [preset, setPreset] = useState<AcpProviderPreset | undefined>();
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<AcpProviderProfile | null>(null);
	useEffect(() => { setState(getAcpProviderState(agent)); }, [agent]);
	const saveState = async (next: AcpProviderState) => {
		setBusy(true); setError(null); setMessage(null);
		try {
			const latest = (await api.acpState()).agents.find((entry) => entry.id === agent.id);
			if (!latest) throw new Error(t("acpModels.unavailable"));
			const agents = await api.acpSaveAgent({ ...latest, providerState: next });
			const saved = agents.find((entry) => entry.id === agent.id);
			setState(saved ? getAcpProviderState(saved) : next);
			setMessage(t("acpProviders.saved"));
		} finally { setBusy(false); }
	};
	const run = (action: () => Promise<void>) => { void action().catch((cause) => setError(errorMessage(cause))); };
	const pick = (selected?: AcpProviderPreset) => { setPreset(selected); setDraft(profileFromPreset(agent.id, selected)); setEditing(false); setPage("form"); setError(null); };
	const edit = (profile: AcpProviderProfile) => { setDraft(profile); setPreset(ACP_PROVIDER_PRESETS[agent.id as "codex" | "claude"]?.find((entry) => entry.id === profile.presetId)); setEditing(true); setPage("form"); setError(null); };
	const move = (profile: AcpProviderProfile, offset: number) => {
		const profiles = [...state.profiles]; const index = profiles.findIndex((entry) => entry.id === profile.id); const target = index + offset;
		if (index < 0 || target < 0 || target >= profiles.length) return;
		[profiles[index], profiles[target]] = [profiles[target], profiles[index]];
		run(() => saveState({ ...state, profiles }));
	};
	return <section className="flex flex-col gap-4">
		<div className="flex items-center gap-2">
			<div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{agent.name} · {t("providers.tab")}</h2>
				<p className={cn(muted, "mt-1")}>{t("acpProviders.listHint")}</p>
			</div>
			<Button size="sm" variant="subtle" disabled={busy} onClick={() => { setEditing(false); setPage("pick"); setMessage(null); setError(null); }}><PlusIcon className="size-3.5" />{t("acpProviders.add")}</Button>
		</div>
		{error && page === "list" ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
		{message && page === "list" ? <p role="status" className={muted}>{message}</p> : null}
		<Input aria-label={t("acpProviders.search")} placeholder={t("acpProviders.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
		<AcpProviderList agentId={agent.id} state={state} query={query} busy={busy} onActivate={(profile) => run(() => saveState({ ...state, activeId: profile.id }))} onEdit={edit}
			onDuplicate={(profile) => run(() => saveState({ ...state, profiles: [...state.profiles, { ...profile, id: newId(), name: `${profile.name} ${t("acpProviders.copySuffix")}` }] }))}
			onDelete={setPendingDelete} onMove={move} />
		{page !== "list" ? <SettingsDialog wide title={t(editing ? "acpProviders.edit" : "acpProviders.add")}
			description={t(page === "pick" ? "acpProviders.pickHint" : "acpProviders.formHint")}
			onClose={() => { if (!busy) { setPage("list"); setError(null); } }}
			footer={page === "pick" ? <Button size="sm" variant="ghost" onClick={() => setPage("list")}>{t("common.cancel")}</Button> : null}>
			{page === "pick" ? <AcpPresetPicker agentId={agent.id} onPick={pick} /> : draft ? <AcpProviderForm key={`${draft.id}-${draft.presetId}`} agentId={agent.id} initial={draft} preset={preset} editing={editing} busy={busy}
				onChangePreset={() => setPage("pick")} onCancel={() => setPage("list")} onSave={async (profile) => {
					const savedProfile = { ...profile, id: profile.id || newId() };
					await saveState({ ...state, profiles: editing ? state.profiles.map((entry) => entry.id === profile.id ? savedProfile : entry) : [...state.profiles, savedProfile] });
					setPage("list");
				}} /> : null}
		</SettingsDialog> : null}
		<ConfirmDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open && !busy) setPendingDelete(null); }} title={t("acpProviders.deleteTitle")} description={pendingDelete ? t("acpProviders.deleteDescription", { name: pendingDelete.name }) : ""}
			footer={<><Button size="sm" variant="ghost" disabled={busy} onClick={() => setPendingDelete(null)}>{t("common.cancel")}</Button><Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => run(async () => { if (!pendingDelete || pendingDelete.id === state.activeId) return; await saveState({ ...state, profiles: state.profiles.filter((entry) => entry.id !== pendingDelete.id) }); setPendingDelete(null); })}>{t("acpProviders.delete")}</Button></>} />
	</section>;
}
