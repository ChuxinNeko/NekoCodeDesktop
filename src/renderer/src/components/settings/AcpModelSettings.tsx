import { useState } from "react";
import type { AcpAgentInfo, AcpModelSettings as ModelSettings } from "../../../../shared/acp";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { formatKeyValueLines, parseKeyValueLines } from "../../../../shared/mcp";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function AcpModelSettings({ agent }: { agent: AcpAgentInfo }) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<ModelSettings>(agent.modelSettings ?? { mode: "inherit", baseUrl: "", apiKey: "", model: "" });
	const [env, setEnv] = useState(formatKeyValueLines(agent.env));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const supported = agent.id === "codex" || agent.id === "claude";
	const field = (key: "baseUrl" | "apiKey" | "model" | "haiku" | "sonnet" | "opus", label: string, placeholder = "") => (
		<label className="flex flex-col gap-1 text-xs">
			{label}
			<Input type={key === "apiKey" ? "password" : "text"} autoComplete="off" value={draft[key] ?? ""} placeholder={placeholder}
				onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }); setSaved(false); }} />
		</label>
	);
	const save = async () => {
		setBusy(true); setError(null); setSaved(false);
		try {
			// Read the latest launch configuration so edits elsewhere are preserved.
			const latest = (await api.acpState()).agents.find((entry) => entry.id === agent.id);
			if (!latest) throw new Error(t("acpModels.unavailable"));
			await api.acpSaveAgent({ ...latest, ...(supported ? { modelSettings: draft } : { env: parseKeyValueLines(env) }) });
			setSaved(true);
		} catch (cause) { setError(errorMessage(cause)); }
		finally { setBusy(false); }
	};
	return <section className="flex flex-col gap-3 rounded-lg border border-[color:var(--app-surface-divider)] p-3">
		<div className="text-sm font-medium">{agent.name} · ACP</div>
		<p className="text-xs leading-relaxed text-muted-foreground">{t("acpModels.intro")}</p>
		<fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
			{supported ? <>
				<div className="flex flex-wrap gap-2" role="group" aria-label={t("acpModels.source")}>
					{(["inherit", "official", "custom"] as const).map((mode) => <button key={mode} type="button" aria-pressed={draft.mode === mode}
						className={cn("rounded-lg border px-3 py-2 text-xs transition-colors", draft.mode === mode ? "border-primary bg-primary/10 text-foreground" : "border-[color:var(--app-surface-divider)] text-muted-foreground")}
						onClick={() => { setDraft({ ...draft, mode }); setSaved(false); }}>{t(`acpModels.${mode}`)}</button>)}
				</div>
				{draft.mode === "inherit" ? <p className="text-xs text-muted-foreground">{t("acpModels.inheritHint")}</p> : <>
					<p className="text-xs text-muted-foreground">{t(agent.id === "codex" ? "acpModels.codexProtocol" : "acpModels.claudeProtocol")}</p>
					{draft.mode === "custom" ? field("baseUrl", t("acpModels.baseUrl"), agent.id === "codex" ? "https://example.com/v1" : "https://example.com") :
						<p className="break-all font-mono text-xs text-muted-foreground">{agent.id === "codex" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}</p>}
					{field("apiKey", t("acpModels.apiKey"), draft.mode === "official" ? t("acpModels.loginHint") : "sk-…")}
					{field("model", t("acpModels.model"), draft.mode === "official" ? t("acpModels.defaultModel") : "model-id")}
					{agent.id === "codex" ? <label className="flex flex-col gap-1 text-xs">{t("acpModels.reasoning")}
						<select className="rounded-md border border-[color:var(--app-surface-divider)] bg-background px-2 py-1.5" value={draft.reasoning ?? ""}
							onChange={(event) => { setDraft({ ...draft, reasoning: event.target.value as ModelSettings["reasoning"] }); setSaved(false); }}>
							{["", "low", "medium", "high", "xhigh"].map((value) => <option key={value} value={value}>{value || t("acpModels.defaultModel")}</option>)}
						</select>
					</label> : <details><summary className="cursor-pointer text-xs text-muted-foreground">{t("acpModels.mapping")}</summary>
						<div className="mt-3 grid gap-3 sm:grid-cols-3">{field("haiku", "Haiku")}{field("sonnet", "Sonnet")}{field("opus", "Opus")}</div>
					</details>}
				</>}
			</> : <label className="flex flex-col gap-2 text-xs">{t("acpModels.envHint")}
				<Textarea className="min-h-32 font-mono" value={env} onChange={(event) => { setEnv(event.target.value); setSaved(false); }} />
			</label>}
			<div className="flex items-center gap-3">
				<Button size="sm" variant="subtle" disabled={busy || (supported && draft.mode === "custom" && (!draft.baseUrl.trim() || !draft.apiKey.trim() || !draft.model.trim()))} onClick={() => void save()}>{t("common.save")}</Button>
				{saved ? <span role="status" className="text-xs text-muted-foreground">{t("acpModels.saved")}</span> : null}
			</div>
		</fieldset>
		{error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
	</section>;
}
