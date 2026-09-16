import { useEffect, useState } from "react";
import type { GitHubAuthStatus } from "../../../../shared/pullRequests";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";

export function GitHubSettings() {
	const { t } = useTranslation();
	const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reload = async () => {
		try {
			setStatus(await api.githubStatus());
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	useEffect(() => {
		void reload();
	}, []);

	const save = async () => {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const next = await api.githubSave(token);
			setStatus(next);
			setToken("");
			setMessage(t("github.savedAs", { login: next.login ?? "unknown" }));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			setStatus(await api.githubClear());
			setMessage(t("github.cleared"));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};

	const sourceLabel = (source: NonNullable<GitHubAuthStatus["source"]>) => {
		switch (source) {
			case "settings":
				return t("github.source.settings");
			case "gh-cli":
				return t("github.source.ghCli");
			case "anonymous":
				return t("github.source.anonymous");
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<span className="text-[length:var(--app-font-size-ui,12px)]">{t("github.title")}</span>
				<span className={cn("text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					{t("github.description")}
				</span>
			</div>

			<div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
				<span className="text-[length:var(--app-font-size-ui-sm,11px)]">
					{status?.configured ? t("github.configured") : t("github.notConfigured")}
				</span>
				{status?.source ? (
					<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						{t("github.via", { source: sourceLabel(status.source) })}
					</span>
				) : null}
				{status?.login ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						@{status.login}
					</span>
				) : null}
			</div>

			{status?.warning ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--warning)]">
					{status.warning}
				</p>
			) : null}

			<div className="flex flex-col gap-1">
				<Label>{t("github.token")}</Label>
				<div className="flex items-center gap-2">
					<Input
						disabled={status !== null && !status.encryptionAvailable}
						onChange={(event) => setToken(event.target.value)}
						placeholder="ghp_…"
						type="password"
						value={token}
					/>
					<Button
						disabled={busy || token.trim().length === 0}
						onClick={() => void save()}
						size="sm"
						variant="subtle"
					>
						{t("common.save")}
					</Button>
					<Button disabled={busy} onClick={() => void clear()} size="sm" variant="chrome-outline">
						{t("common.clear")}
					</Button>
				</div>
			</div>

			{error ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">{error}</p>
			) : null}
			{message ? (
				<p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{message}
				</p>
			) : null}
		</section>
	);
}
