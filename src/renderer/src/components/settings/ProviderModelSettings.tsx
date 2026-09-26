import { useEffect, useState } from "react";
import type {
	FetchedModel,
	ModelProfileSummary,
	ModelStoreStatus,
	OAuthLoginOptions,
	OAuthProviderId,
	OAuthProviderSummary,
} from "../../../../shared/settings";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";
import { ModelsTab , type ModelSettingsChange } from "./ModelsTab";
import {
	draftContextWindow,
	draftMaxTokens,
	emptyProviderDraft,
	ProvidersTab,
	type ProviderDraft,
} from "./ProvidersTab";

const TABS = [
	{ id: "providers", labelKey: "providers.tab" },
	{ id: "models", labelKey: "models.tab" },
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey }>;

type TabId = (typeof TABS)[number]["id"];

/**
 * A sign-in in flight. It outlives any single call — the browser half happens
 * out of process — so the page follows it through events rather than a promise.
 */
export interface OAuthLoginState {
	provider: OAuthProviderId;
	url?: string;
	message?: string;
	/** The callback could not be received; the code has to be pasted in. */
	manual: boolean;
	/** A device-code flow: the code to enter, and where. */
	deviceCode?: { userCode: string; verificationUri: string; expiresAt?: number };
}

/**
 * Providers and models are two steps of one job, so they are two tabs of one
 * page: a provider is an endpoint plus a key, and its models are pulled from
 * that endpoint afterwards. Saving a new provider therefore lands on the models
 * tab with its list already loading — the step nobody would want to hunt for.
 *
 * All backend traffic lives here; both tabs render what this hands them.
 */
export function ProviderModelSettings() {
	const { t } = useTranslation();
	const [tab, setTab] = useState<TabId>("providers");
	const [profiles, setProfiles] = useState<ModelProfileSummary[]>([]);
	const [accounts, setAccounts] = useState<OAuthProviderSummary[]>([]);
	const [login, setLogin] = useState<OAuthLoginState | null>(null);
	const [status, setStatus] = useState<ModelStoreStatus | null>(null);
	const [draft, setDraft] = useState<ProviderDraft | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [autoFetchId, setAutoFetchId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = async () => {
		const [nextProfiles, nextStatus, nextAccounts] = await Promise.all([
			api.modelList(),
			api.modelStatus(),
			api.oauthList(),
		]);
		setProfiles(nextProfiles);
		setStatus(nextStatus);
		setAccounts(nextAccounts);
		const nextOAuthAccounts = nextAccounts.filter(
			(account) => account.signedIn && account.modelIds.length > 0,
		);
		setSelectedId((previous) =>
			previous &&
			(nextProfiles.some((entry) => entry.id === previous) ||
				nextOAuthAccounts.some((entry) => entry.id === previous))
				? previous
				: (nextProfiles[0]?.id ?? nextOAuthAccounts[0]?.id ?? null),
		);
	};

	useEffect(() => {
		reload().catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);

	// The browser half of a sign-in reports back here, including when it fails
	// after this page stopped awaiting anything.
	useEffect(
		() =>
			api.onOAuthEvent((event) => {
				if (event.kind === "url") {
					setLogin((previous) => ({ provider: event.provider, manual: false, ...previous, url: event.url }));
					return;
				}
				if (event.kind === "progress") {
					setLogin((previous) =>
						previous ? { ...previous, message: event.message } : { provider: event.provider, manual: false },
					);
					return;
				}
				if (event.kind === "device-code") {
					const { userCode, verificationUri, expiresAt } = event;
					setLogin((previous) => ({
						provider: event.provider,
						manual: false,
						...previous,
						deviceCode: { userCode, verificationUri, ...(expiresAt ? { expiresAt } : {}) },
					}));
					return;
				}
				if (event.kind === "manual-code") {
					setLogin((previous) => ({ provider: event.provider, ...previous, manual: true }));
					return;
				}
				setLogin(null);
				if (event.kind === "error") setError(event.message);
			}),
		[],
	);

	/** Every mutation goes through here so failures land in one place. */
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			await action();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const saveProvider = () =>
		void run(async () => {
			if (!draft) return;
			const isNew = draft.id === undefined;
			const existing = profiles.find((entry) => entry.id === draft.id);
			// Save is disabled while either field is unparseable, so both resolve.
			const contextWindow = draftContextWindow(draft);
			const maxTokens = draftMaxTokens(draft);
			const summary = await api.modelSave({
				...(draft.id ? { id: draft.id } : {}),
				kind: draft.kind,
				name: draft.name.trim(),
				baseUrl: draft.baseUrl.trim(),
				route: draft.route.trim(),
				api: draft.api,
				// Blank means "keep the stored key": the form never receives it back.
				...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
				modelIds: existing?.modelIds ?? [],
				reasoning: draft.reasoning,
				imageInput: draft.imageInput,
				...(contextWindow === null ? {} : { contextWindow }),
				...(maxTokens === null ? {} : { maxTokens }),
			});
			setDraft(null);
			await reload();
			setMessage(t("providers.saved"));
			if (isNew) {
				setSelectedId(summary.id);
				setAutoFetchId(summary.id);
				setTab("models");
			}
		});

	const deleteProvider = (id: string) =>
		void run(async () => {
			await api.modelDelete(id);
			await reload();
		});

	/**
	 * Start a sign-in. Not run through `run()`: the browser half takes as long as
	 * the user takes, and the page has to stay usable meanwhile. The outcome
	 * arrives as an event, so the only thing awaited here is the point at which
	 * the provider's models are registered.
	 */
	const startLogin = (provider: OAuthProviderId, options?: OAuthLoginOptions) => {
		setError(null);
		setMessage(null);
		setDraft(null);
		setLogin({ provider, manual: false });
		api
			.oauthLogin(provider, options)
			.then(async () => {
				await reload();
				setMessage(t("oauth.signedIn"));
			})
			.catch(() => {
				// Reported through the event stream, including cancellation.
			});
	};

	const logout = (provider: OAuthProviderId) =>
		void run(async () => {
			await api.oauthLogout(provider);
			await reload();
		});

	const saveModels = (profile: ModelProfileSummary, modelIds: string[]) =>
		void run(async () => {
			await api.modelSave({
				id: profile.id,
				kind: profile.kind,
				name: profile.name,
				baseUrl: profile.baseUrl,
				route: profile.route,
				api: profile.api,
				modelIds,
				reasoning: profile.reasoning,
				imageInput: profile.imageInput,
			});
			await reload();
		});

	const fetchModels = async (profile: ModelProfileSummary): Promise<FetchedModel[] | null> => {
		let models: FetchedModel[] | null = null;
		await run(async () => {
			models = await api.modelFetch({
				// The stored key is used; it never travels back to the renderer.
				profileId: profile.id,
				baseUrl: profile.baseUrl,
				route: profile.route,
				api: profile.api,
			});
		});
		return models;
	};

	const saveModelSettings = (
		profile: ModelProfileSummary,
		modelId: string,
		change: ModelSettingsChange,
	) =>
		void run(async () => {
			const modelOverrides = { ...(profile.modelOverrides ?? {}) };
			if (change.limits === null) delete modelOverrides[modelId];
			else if (change.limits) modelOverrides[modelId] = { ...change.limits };
			const modelThinking = { ...(profile.modelThinking ?? {}) };
			if (change.thinking === null) delete modelThinking[modelId];
			else if (change.thinking) modelThinking[modelId] = [...change.thinking];
			await api.modelSave({
				id: profile.id,
				kind: profile.kind,
				name: profile.name,
				baseUrl: profile.baseUrl,
				route: profile.route,
				api: profile.api,
				modelIds: profile.modelIds,
				reasoning: profile.reasoning,
				imageInput: profile.imageInput,
				modelOverrides,
				modelThinking,
			});
			await reload();
		});

	const testModel = (profileId: string, modelId: string) =>
		void run(async () => {
			const result = await api.modelTest({ profileId, modelId });
			setMessage(
				`${result.ok ? t("models.testOk") : t("models.testFailed")} · ${String(result.latencyMs)}ms · ${result.message}`,
			);
		});

	return (
		<section className="flex flex-col gap-3">
			{status?.warning ? (
				<p className="rounded-lg border border-[var(--warning)]/40 px-2.5 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					{status.warning}
				</p>
			) : null}

			<div className="flex items-center gap-2">
				<div className="flex items-center gap-1 rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
					{TABS.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setTab(entry.id)}
							className={cn(
								"rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
								tab === entry.id
									? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{t(entry.labelKey)}
						</button>
					))}
				</div>
				<div className="flex-1" />
				{busy ? <Spinner className="size-3 text-muted-foreground" /> : null}
			</div>

			{error ? (
				<p className="whitespace-pre-wrap text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</p>
			) : null}
			{message ? (
				<p className="whitespace-pre-wrap break-words text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{message}</p>
			) : null}

			{tab === "providers" ? (
				<ProvidersTab
					profiles={profiles}
					accounts={accounts}
					login={login}
					draft={draft}
					busy={busy}
					onDraftChange={setDraft}
					onSave={saveProvider}
					onDelete={deleteProvider}
					onLogin={startLogin}
					onCancelLogin={() => login && void api.oauthCancel(login.provider)}
					onSubmitCode={(code) => login && void api.oauthSubmitCode(login.provider, code)}
					onLogout={logout}
					onRefresh={(provider) => void run(async () => { await api.oauthRefresh(provider); await reload(); setMessage(t("oauth.refreshed")); })}
					onManageModels={(id) => {
						setSelectedId(id);
						setTab("models");
					}}
				/>
			) : (
				<ModelsTab
					profiles={profiles}
					accounts={accounts}
					selectedId={selectedId}
					busy={busy}
					autoFetchId={autoFetchId}
					onSelect={setSelectedId}
					onAutoFetchHandled={() => setAutoFetchId(null)}
					onFetch={fetchModels}
					onSaveModels={saveModels}
					onSaveModelSettings={saveModelSettings}
					onTest={testModel}
					onAddProvider={() => {
						setDraft(emptyProviderDraft());
						setTab("providers");
					}}
				/>
			)}
		</section>
	);
}
