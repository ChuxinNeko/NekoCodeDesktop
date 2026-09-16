import { useEffect, useState } from "react";
import type {
	FetchedModel,
	ModelApiProtocol,
	ModelProfileSummary,
	ModelStoreStatus,
} from "../../../../shared/settings";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { TrashCanIcon, PlusIcon } from "../../lib/icons";

const PROTOCOL_DEFAULT_ROUTE: Record<ModelApiProtocol, string> = {
	"openai-completions": "/v1/chat/completions",
	"openai-responses": "/v1/responses",
	"anthropic-messages": "/v1/messages",
};

const PROTOCOL_LABELS: Record<ModelApiProtocol, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
};

interface Draft {
	id?: string;
	name: string;
	baseUrl: string;
	route: string;
	api: ModelApiProtocol;
	apiKey: string;
	modelIds: string;
	reasoning: boolean;
}

function emptyDraft(): Draft {
	return {
		name: "",
		baseUrl: "",
		route: PROTOCOL_DEFAULT_ROUTE["openai-completions"],
		api: "openai-completions",
		apiKey: "",
		modelIds: "",
		reasoning: false,
	};
}

function draftFrom(profile: ModelProfileSummary): Draft {
	return {
		id: profile.id,
		name: profile.name,
		baseUrl: profile.baseUrl,
		route: profile.route,
		api: profile.api,
		apiKey: "",
		modelIds: profile.modelIds.join("\n"),
		reasoning: profile.reasoning,
	};
}

export function ModelSettings() {
	const { t } = useTranslation();
	const [profiles, setProfiles] = useState<ModelProfileSummary[]>([]);
	const [status, setStatus] = useState<ModelStoreStatus | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [fetched, setFetched] = useState<FetchedModel[]>([]);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = async () => {
		try {
			const [nextProfiles, nextStatus] = await Promise.all([api.modelList(), api.modelStatus()]);
			setProfiles(nextProfiles);
			setStatus(nextStatus);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	useEffect(() => {
		void reload();
	}, []);

	const save = async () => {
		if (!draft) return;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			await api.modelSave({
				...(draft.id ? { id: draft.id } : {}),
				name: draft.name,
				baseUrl: draft.baseUrl,
				route: draft.route,
				api: draft.api,
				...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
				modelIds: draft.modelIds
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
				reasoning: draft.reasoning,
			});
			setDraft(null);
			setFetched([]);
			await reload();
			setMessage(t("models.saved"));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string) => {
		setBusy(true);
		try {
			await api.modelDelete(id);
			await reload();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const fetchModels = async () => {
		if (!draft) return;
		setBusy(true);
		setError(null);
		try {
			setFetched(
				await api.modelFetch({
					...(draft.id ? { profileId: draft.id } : {}),
					baseUrl: draft.baseUrl,
					route: draft.route,
					api: draft.api,
					...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
				}),
			);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const test = async (profileId: string, modelId: string) => {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const result = await api.modelTest({ profileId, modelId });
			setMessage(
				`${result.ok ? t("models.testOk") : t("models.testFailed")} · ${String(result.latencyMs)}ms · ${result.message}`,
			);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="flex flex-col gap-3">
			{status?.warning ? (
				<p className="rounded-lg border border-[var(--warning)]/40 px-2.5 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					{status.warning}
				</p>
			) : null}

			<div className="flex items-center gap-2">
				<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("models.endpointsConfigured", { count: profiles.length })}
				</span>
				<div className="flex-1" />
				{busy ? <Spinner className="size-3 text-muted-foreground" /> : null}
				<Button onClick={() => setDraft(emptyDraft())} size="sm" variant="subtle">
					<PlusIcon className="size-3.5" />
					{t("models.add")}
				</Button>
			</div>

			{error ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}
			{message ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{message}</p> : null}

			<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-border">
				{profiles.length === 0 ? (
					<p className="px-3 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("models.empty")}
					</p>
				) : (
					profiles.map((profile) => (
						<div key={profile.id} className="flex flex-col gap-1 px-3 py-2">
							<div className="flex items-center gap-2">
								<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">
									{profile.name}
								</span>
								<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
									{PROTOCOL_LABELS[profile.api]}
								</span>
								<div className="flex-1" />
								<Button onClick={() => setDraft(draftFrom(profile))} size="xs" variant="chrome-outline">
									{t("common.edit")}
								</Button>
								<Button
									onClick={() => void remove(profile.id)}
									size="icon-xs"
									variant="destructive-outline"
								>
									<TrashCanIcon className="size-3.5" />
								</Button>
							</div>
							<span className="truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{profile.baseUrl}
								{profile.route}
							</span>
							<div className="flex flex-wrap gap-1">
								{profile.modelIds.map((modelId) => (
									<button
										key={modelId}
										type="button"
										onClick={() => void test(profile.id, modelId)}
										className={cn(
											"rounded-full border border-border px-2 py-0.5 font-mono text-[length:var(--app-font-size-ui-2xs,9px)]",
											"transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
										)}
										title={t("models.testTooltip")}
									>
										{modelId}
									</button>
								))}
							</div>
						</div>
					))
				)}
			</div>

			{draft ? (
				<div className="flex flex-col gap-3 rounded-xl border border-border p-3">
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<Label>{t("common.name")}</Label>
							<Input
								value={draft.name}
								onChange={(event) => setDraft({ ...draft, name: event.target.value })}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label>{t("models.protocol")}</Label>
							<select
								value={draft.api}
								onChange={(event) => {
									const nextApi = event.target.value as ModelApiProtocol;
									setDraft({
										...draft,
										api: nextApi,
										route: PROTOCOL_DEFAULT_ROUTE[nextApi],
									});
								}}
								className="h-8 rounded-lg border border-border bg-transparent px-2 text-[length:var(--app-font-size-ui,12px)]"
							>
								{Object.entries(PROTOCOL_LABELS).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</div>
						<div className="flex flex-col gap-1">
							<Label>{t("models.baseUrl")}</Label>
							<Input
								placeholder="https://api.example.com"
								value={draft.baseUrl}
								onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label>{t("models.route")}</Label>
							<Input
								value={draft.route}
								onChange={(event) => setDraft({ ...draft, route: event.target.value })}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1">
						<Label>
							{t("models.apiKey")} {draft.id ? t("models.apiKeyKeep") : ""}
						</Label>
						<Input
							type="password"
							value={draft.apiKey}
							onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label>{t("models.modelIds")}</Label>
						<Textarea
							rows={4}
							value={draft.modelIds}
							onChange={(event) => setDraft({ ...draft, modelIds: event.target.value })}
						/>
					</div>
					{fetched.length > 0 ? (
						<div className="flex flex-wrap gap-1">
							{fetched.map((model) => (
								<button
									key={model.id}
									type="button"
									onClick={() => {
										const existing = draft.modelIds
											.split("\n")
											.map((line) => line.trim())
											.filter(Boolean);
										if (existing.includes(model.id)) return;
										setDraft({ ...draft, modelIds: [...existing, model.id].join("\n") });
									}}
									className="rounded-full border border-border px-2 py-0.5 font-mono text-[length:var(--app-font-size-ui-2xs,9px)] hover:bg-[var(--color-background-button-secondary-hover)]"
								>
									{model.id}
								</button>
							))}
						</div>
					) : null}
					{/* PI clamps every thinking level to "off" unless the model is flagged
					    as reasoning-capable, and an OpenAI-compatible endpoint does not
					    advertise that — so it has to be declared here. */}
					<div className="flex items-start gap-3">
						<div className="flex min-w-0 flex-1 flex-col">
							<Label>{t("models.reasoning")}</Label>
							<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{t("models.reasoningHint")}
							</span>
						</div>
						<Button
							onClick={() => setDraft({ ...draft, reasoning: !draft.reasoning })}
							size="sm"
							variant={draft.reasoning ? "subtle" : "chrome-outline"}
						>
							{draft.reasoning ? t("common.on") : t("common.off")}
						</Button>
					</div>
					<div className="flex items-center gap-2">
						<Button onClick={() => void fetchModels()} size="sm" variant="chrome-outline">
							{t("models.fetch")}
						</Button>
						<div className="flex-1" />
						<Button onClick={() => setDraft(null)} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button onClick={() => void save()} size="sm" variant="subtle">
							{t("common.save")}
						</Button>
					</div>
				</div>
			) : null}
		</section>
	);
}
