import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import type { GitHubAuthStatus } from "../../../../shared/pullRequests";
import type { GitHubAuthorization, GitHubAuthorizationMethod } from "../../../../shared/github-oauth";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { CopyIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type Method = GitHubAuthorizationMethod | "manual";

const METHODS = ["browser", "device", "manual"] as const satisfies readonly Method[];

/**
 * How a GitHub connection is made.
 *
 * The settings page only needs to know whether an account is connected. Browser,
 * device-code, and manual token are one decision, made once, so they live here
 * instead of as three forms stacked under the account.
 */
export function GitHubConnectDialog({
	desktop,
	cannotStore,
	onClose,
	onConnected,
}: {
	desktop: boolean;
	cannotStore: boolean;
	onClose: () => void;
	onConnected: (status: GitHubAuthStatus) => void;
}) {
	const { t } = useTranslation();
	const [method, setMethod] = useState<Method>(desktop ? "browser" : "manual");
	const [token, setToken] = useState("");
	const [flow, setFlow] = useState<GitHubAuthorization | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sequence = useRef(0);
	const inFlight = useRef(false);
	const activeId = useRef<string | undefined>(undefined);
	const onConnectedRef = useRef(onConnected);
	onConnectedRef.current = onConnected;

	useEffect(() => {
		return () => {
			sequence.current++;
			if (inFlight.current) void api.githubCancelAuthorization(activeId.current).catch(() => {});
		};
	}, []);

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
					activeId.current = undefined;
					setBusy(false);
					setFlow(null);
					onConnectedRef.current(next.status);
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
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [flow, t]);

	const choose = (next: Method) => {
		if (busy || (!desktop && next !== "manual")) return;
		if (next === method) return;
		if (inFlight.current) {
			sequence.current++;
			inFlight.current = false;
			setFlow(null);
			setBusy(false);
			void api.githubCancelAuthorization(activeId.current).catch(() => {});
			activeId.current = undefined;
		}
		setMethod(next);
		setError(null);
		setMessage(null);
	};

	const start = async () => {
		if (method === "manual") return;
		const request = ++sequence.current;
		inFlight.current = true;
		activeId.current = undefined;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const next = await api.githubAuthorize(method);
			if (sequence.current !== request) return;
			activeId.current = next.id;
			setFlow(next);
		} catch (cause) {
			if (sequence.current !== request) return;
			inFlight.current = false;
			setBusy(false);
			setError(errorMessage(cause));
		}
	};

	const save = async () => {
		const request = ++sequence.current;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const next = await api.githubSave(token);
			if (sequence.current !== request) return;
			setToken("");
			onConnectedRef.current(next);
		} catch (cause) {
			if (sequence.current === request) setError(errorMessage(cause));
		} finally {
			if (sequence.current === request) setBusy(false);
		}
	};

	const copyCode = () => {
		if (!flow?.userCode) return;
		void navigator.clipboard.writeText(flow.userCode).then(
			() => setMessage(t("github.codeCopied")),
			(cause: unknown) => setError(errorMessage(cause)),
		);
	};

	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					className={cn(
						"fixed left-1/2 top-1/2 z-50 flex max-h-[min(40rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
						"w-[32rem] max-w-[calc(100vw-3rem)] flex-col gap-4 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<div className="shrink-0">
						<Dialog.Title className="text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
							{t("github.dialogTitle")}
						</Dialog.Title>
						<Dialog.Description className="mt-1 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">
							{t("github.dialogDescription")}
						</Dialog.Description>
					</div>

					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
						<div role="radiogroup" aria-label={t("github.authorizationMethod")} className="flex flex-col gap-2">
							{METHODS.map((id) => {
								const selected = method === id;
								const disabled = busy || (!desktop && id !== "manual");
								return (
									<button
										key={id}
										type="button"
										role="radio"
										aria-checked={selected}
										disabled={disabled}
										tabIndex={selected ? 0 : -1}
										onClick={() => choose(id)}
										className={cn(
											"flex items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors disabled:opacity-50",
											selected ? "border-foreground/45 bg-secondary/40" : "border-border hover:bg-secondary/20",
										)}
									>
										<span
											aria-hidden="true"
											className={cn(
												"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
												selected ? "border-foreground" : "border-muted-foreground/40",
											)}
										>
											{selected ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
										</span>
										<span className="min-w-0">
											<span className="block text-[length:var(--app-font-size-ui,12px)] font-medium">
												{t(id === "browser" ? "github.method.browser" : id === "device" ? "github.method.device" : "github.method.manual")}
											</span>
											<span className="mt-0.5 block text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">
												{t(id === "browser" ? "github.method.browserHint" : id === "device" ? "github.method.deviceHint" : "github.method.manualHint")}
											</span>
										</span>
									</button>
								);
							})}
						</div>

						{!desktop ? (
							<p className="text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">
								{t("github.desktopAuthorization")}
							</p>
						) : null}

						{method === "manual" ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="github-token">{t("github.token")}</Label>
								<Input
									id="github-token"
									disabled={busy || cannotStore}
									onChange={(event) => setToken(event.target.value)}
									placeholder="ghp_…"
									type="password"
									autoComplete="off"
									value={token}
								/>
							</div>
						) : null}

						{flow ? (
							<div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/20 p-3" aria-live="polite">
								<p className="text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed text-muted-foreground">
									{t(flow.method === "device" ? "github.deviceInstructions" : "github.browserInstructions")}
								</p>
								{flow.userCode ? (
									<div className="flex flex-wrap items-center gap-2">
										<code className="select-all rounded-lg bg-background px-3 py-2 text-lg font-semibold tracking-[0.3em]">
											{flow.userCode}
										</code>
										<Button size="sm" variant="ghost" onClick={copyCode}>
											<CopyIcon className="size-3.5" />
											{t("github.copyCode")}
										</Button>
									</div>
								) : null}
								<Button
									size="sm"
									variant="chrome-outline"
									className="self-start"
									onClick={() => void api.githubOpenAuthorization().catch((cause: unknown) => setError(errorMessage(cause)))}
								>
									{t("github.openAuthorization")}
								</Button>
							</div>
						) : null}

						{error ? (
							<p role="alert" className="text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
								{error}
							</p>
						) : null}
						{message ? (
							<p role="status" className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
								{message}
							</p>
						) : null}
					</div>

					<div className="flex shrink-0 items-center justify-end gap-2">
						<Button onClick={onClose} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						{flow ? null : method === "manual" ? (
							<Button disabled={busy || cannotStore || token.trim().length === 0} onClick={() => void save()} size="sm" variant="subtle">
								{t("common.save")}
							</Button>
						) : (
							<Button disabled={busy || cannotStore || !desktop} onClick={() => void start()} size="sm" variant="subtle">
								{t("github.start")}
							</Button>
						)}
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
