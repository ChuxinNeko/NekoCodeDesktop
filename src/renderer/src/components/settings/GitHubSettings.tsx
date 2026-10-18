import { useEffect, useRef, useState } from "react";
import type { GitHubAuthStatus } from "../../../../shared/pullRequests";
import type { GitHubAuthorization, GitHubAuthorizationMethod } from "../../../../shared/github-oauth";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";

export function GitHubSettings() {
	const { t } = useTranslation();
	const desktop = api.runtime === "electron";
	const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [method, setMethod] = useState<GitHubAuthorizationMethod>("browser");
	const [flow, setFlow] = useState<GitHubAuthorization | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sequence = useRef(0);
	const inFlight = useRef(false);
	const activeId = useRef<string | undefined>(undefined);

	useEffect(() => {
		let alive = true;
		void api.githubStatus().then(value => { if (alive) setStatus(value); }).catch(cause => { if (alive) setError(errorMessage(cause)); });
		return () => {
			alive = false;
			sequence.current++;
			if (desktop && inFlight.current) void api.githubCancelAuthorization(activeId.current).catch(() => {});
		};
	}, [desktop]);

	useEffect(() => {
		if (!flow) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				if (Date.now() >= flow.expiresAt) throw new Error(t("github.authorizationExpired"));
				const next = await api.githubPollAuthorization(flow.id);
				if (stopped) return;
				if (next.state === "complete") {
					inFlight.current = false;
					setStatus(next.status);
					activeId.current = undefined;
					setMessage(t("github.connectedAs", { login: next.status.login ?? "unknown" }));
					setBusy(false);
					setFlow(null);
				} else timer = setTimeout(poll, Math.max(1, next.interval) * 1000);
			} catch (cause) {
				if (stopped) return;
				inFlight.current = false;
				setError(errorMessage(cause));
				setBusy(false);
				setFlow(null);
				void api.githubCancelAuthorization(flow.id).catch(() => {});
			}
		};
		timer = setTimeout(poll, flow.interval * 1000);
		return () => { stopped = true; clearTimeout(timer); };
	}, [flow, t]);

	const start = async () => {
		const request = ++sequence.current;
		inFlight.current = true;
		activeId.current = undefined;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const next = await api.githubAuthorize(method);
			if (sequence.current === request) { activeId.current = next.id; setFlow(next); }
		} catch (cause) {
			if (sequence.current !== request) return;
			inFlight.current = false;
			setBusy(false);
			setError(errorMessage(cause));
		}
	};

	const cancel = () => {
		sequence.current++;
		inFlight.current = false;
		setFlow(null);
		setBusy(false);
		void api.githubCancelAuthorization(activeId.current).catch(cause => setError(errorMessage(cause)));
		activeId.current = undefined;
	};

	const save = async () => {
		const request = ++sequence.current;
		setBusy(true); setError(null); setMessage(null);
		try {
			const next = await api.githubSave(token);
			if (sequence.current !== request) return;
			setStatus(next); setToken("");
			setMessage(t("github.savedAs", { login: next.login ?? "unknown" }));
		} catch (cause) { if (sequence.current === request) setError(errorMessage(cause)); }
		finally { if (sequence.current === request) setBusy(false); }
	};

	const clear = async () => {
		const request = ++sequence.current;
		setBusy(true); setError(null); setMessage(null);
		try {
			const next = await api.githubClear();
			if (sequence.current !== request) return;
			setStatus(next); setMessage(t("github.cleared"));
		} catch (cause) { if (sequence.current === request) setError(errorMessage(cause)); }
		finally { if (sequence.current === request) setBusy(false); }
	};

	const sourceLabel = (source: NonNullable<GitHubAuthStatus["source"]>) => {
		switch (source) {
			case "settings": return t("github.source.settings");
			case "oauth": return t(status?.authorizationMethod === "device" ? "github.method.device" : "github.method.browser");
			case "gh-cli": return t("github.source.ghCli");
			case "anonymous": return t("github.source.anonymous");
		}
	};
	const cannotStore = status !== null && !status.encryptionAvailable;
	const openAuthorization = () => void api.githubOpenAuthorization().catch(cause => setError(errorMessage(cause)));

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<span className="text-[length:var(--app-font-size-ui,12px)]">{t("github.title")}</span>
				<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>{t("github.description")}</span>
			</div>
			<div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2" aria-live="polite">
				<span className="text-[length:var(--app-font-size-ui-sm,11px)]">{status?.configured ? t("github.configured") : t("github.notConfigured")}</span>
				{status?.source ? <span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>{t("github.via", { source: sourceLabel(status.source) })}</span> : null}
				{status?.login ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">@{status.login}</span> : null}
				{status?.source === "oauth" ? <Button disabled={busy} onClick={() => void clear()} size="sm" variant="ghost">{t("github.disconnect")}</Button> : null}
			</div>
			{status?.warning ? <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">{status.warning}</p> : null}

			{desktop ? (
				<div className="flex flex-col gap-3">
					<div role="radiogroup" aria-label={t("github.authorizationMethod")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						{(["browser", "device"] as const).map(id => (
							<button key={id} type="button" role="radio" aria-checked={method === id} disabled={busy}
								onClick={() => setMethod(id)} onKeyDown={event => {
									if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
										event.preventDefault(); setMethod(id === "browser" ? "device" : "browser");
										const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]");
										buttons?.[id === "browser" ? 1 : 0]?.focus();
									}
								}}
								tabIndex={method === id ? 0 : -1}
								className={cn("flex flex-col gap-1 rounded-lg border px-3 py-3 text-left transition-colors disabled:opacity-50", method === id ? "border-foreground/45 bg-secondary/40" : "border-border hover:bg-secondary/20")}>
								<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t(id === "browser" ? "github.method.browser" : "github.method.device")}</span>
								<span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t(id === "browser" ? "github.method.browserHint" : "github.method.deviceHint")}</span>
							</button>
						))}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button disabled={busy || cannotStore || status === null} onClick={() => void start()} size="sm" variant="subtle">{t(busy ? "github.waiting" : "github.connect")}</Button>
						{busy ? <Button onClick={cancel} size="sm" variant="chrome-outline">{t("common.cancel")}</Button> : null}
					</div>
					{flow ? (
						<div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/20 p-3" aria-live="polite">
							<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t(flow.method === "device" ? "github.deviceInstructions" : "github.browserInstructions")}</p>
							{flow.userCode ? <div className="flex items-center gap-2"><code className="select-all text-lg font-semibold tracking-widest">{flow.userCode}</code><Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(flow.userCode!).then(() => setMessage(t("github.codeCopied"))).catch(cause => setError(errorMessage(cause)))}>{t("github.copyCode")}</Button></div> : null}
							<Button size="sm" variant="chrome-outline" className="self-start" onClick={openAuthorization}>{t("github.openAuthorization")}</Button>
						</div>
					) : null}
					{status?.installationUrl && /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(status.installationUrl) ? <div className="flex flex-col items-start gap-1"><Button size="sm" variant="chrome-outline" onClick={() => void api.openExternal(status.installationUrl!).catch(cause => setError(errorMessage(cause)))}>{t("github.manageRepositories")}</Button><p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("github.repositoryAccessHint")}</p></div> : null}
				</div>
			) : <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("github.desktopAuthorization")}</p>}

			<details className="rounded-lg border border-border px-3 py-2">
				<summary className="cursor-pointer text-[length:var(--app-font-size-ui-sm,11px)]">{t("github.manualToken")}</summary>
				<div className="mt-3 flex flex-col gap-1">
					<Label htmlFor="github-token">{t("github.token")}</Label>
					<div className="flex flex-wrap items-center gap-2">
						<Input id="github-token" className="min-w-0 flex-1" disabled={busy || cannotStore} onChange={event => setToken(event.target.value)} placeholder="ghp_…" type="password" autoComplete="off" value={token} />
						<Button disabled={busy || cannotStore || token.trim().length === 0} onClick={() => void save()} size="sm" variant="subtle">{t("common.save")}</Button>
						<Button disabled={busy} onClick={() => void clear()} size="sm" variant="chrome-outline">{t("common.clear")}</Button>
					</div>
				</div>
			</details>
			{error ? <p role="alert" className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p> : null}
			{message ? <p role="status" className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{message}</p> : null}
		</section>
	);
}
