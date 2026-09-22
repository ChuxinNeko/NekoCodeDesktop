import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import type {
	RelayLoginRequest,
	RelayRegisterRequest,
	RelayResendRequest,
	RelayVerifyRequest,
} from "../../../../shared/relay";
import { errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { OtpInput } from "../ui/otp-input";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

type Step = "login" | "register" | "verify";

export function RelayLoginDialog({
	onClose,
	onLogin,
	onRegister,
	onVerify,
	onResend,
}: {
	onClose: () => void;
	onLogin: (request: RelayLoginRequest) => Promise<void>;
	onRegister: (request: RelayRegisterRequest) => Promise<void>;
	onVerify: (request: RelayVerifyRequest) => Promise<void>;
	onResend: (request: RelayResendRequest) => Promise<void>;
}) {
	const { t } = useTranslation();
	const [step, setStep] = useState<Step>("login");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [code, setCode] = useState("");
	const [codeInvalid, setCodeInvalid] = useState(0);
	const [busy, setBusy] = useState(false);
	const runningRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [cooldown, setCooldown] = useState(0);

	useEffect(() => {
		if (cooldown <= 0) return;
		const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
		return () => clearTimeout(timer);
	}, [cooldown]);

	const trimmedEmail = email.trim();
	const emailValid = EMAIL_PATTERN.test(trimmedEmail);
	const passwordValid = password.length >= 8 && password.length <= 256;
	const mismatch = step === "register" && confirm !== "" && confirm !== password;
	const complete = emailValid && passwordValid && (step !== "register" || confirm === password);
	const codeComplete = /^\d{6}$/.test(code);

	const run = async (action: () => Promise<void>) => {
		if (runningRef.current) return;
		runningRef.current = true;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await action();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			runningRef.current = false;
			setBusy(false);
		}
	};

	const switchStep = (next: Step) => {
		setStep(next);
		setError(null);
		setNotice(null);
		setCodeInvalid(0);
	};

	const verifyCode = (submitted: string) =>
		void run(async () => {
			try {
				await onVerify({ email: trimmedEmail, code: submitted });
			} catch (cause) {
				setCodeInvalid((nonce) => nonce + 1);
				throw cause;
			}
		});

	const submit = () => {
		if (step === "login") {
			void run(() => onLogin({ email: trimmedEmail, password }));
		} else if (step === "register") {
			void run(async () => {
				await onRegister({ email: trimmedEmail, password });
				setCode("");
				setCodeInvalid(0);
				setCooldown(60);
				setStep("verify");
				setNotice(t("mobile.publicCodeSent", { email: trimmedEmail }));
			});
		} else {
			verifyCode(code);
		}
	};

	const submitEnabled = step === "verify" ? codeComplete : complete;
	const busyLabel =
		step === "login"
			? t("mobile.publicSigningIn")
			: step === "register"
				? t("mobile.publicRegistering")
				: t("mobile.publicVerifying");
	const actionLabel =
		step === "login"
			? t("mobile.publicLogin")
			: step === "register"
				? t("mobile.publicRegister")
				: t("mobile.publicVerifyAction");

	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
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
						"fixed left-1/2 top-1/2 z-50 flex h-[min(26rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
						"flex-col gap-3 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						"w-[32rem] max-w-[calc(100vw-3rem)]",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<Dialog.Title className="shrink-0 text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
						{t(
							step === "register"
								? "mobile.publicRegisterTitle"
								: step === "verify"
									? "mobile.publicVerifyTitle"
									: "mobile.publicDialogTitle",
						)}
					</Dialog.Title>
					<form
						id="relay-account-form"
						className="flex min-h-0 flex-1 flex-col overflow-y-auto"
						onSubmit={(event) => {
							event.preventDefault();
							if (submitEnabled && !busy) submit();
						}}
					>
						{/* `my-auto` centers the step content in the fixed-height dialog
						    while still scrolling correctly when it overflows. */}
						<div className="my-auto flex flex-col gap-3 py-1">
							{step === "register" ? (
								<p className="text-xs leading-relaxed text-muted-foreground">
									{t("mobile.publicRegisterIntro")}
								</p>
							) : null}
							{step === "verify" ? (
								<p className="text-xs leading-relaxed text-muted-foreground">
									{t("mobile.publicVerifyIntro", { email: trimmedEmail })}
								</p>
							) : null}
							{step === "verify" ? (
								<div className="flex flex-col items-center gap-4">
									<Label>{t("mobile.publicCode")}</Label>
									<OtpInput
										autoFocus
										aria-label={t("mobile.publicCode")}
										disabled={busy}
										invalid={codeInvalid > 0}
										invalidNonce={codeInvalid}
										value={code}
										onChange={(next) => {
											setCode(next);
											setCodeInvalid(0);
											setError(null);
										}}
										onComplete={(completed) => {
											if (!busy) verifyCode(completed);
										}}
									/>
								</div>
							) : (
							<>
								<div className="flex flex-col gap-1">
									<Label>{t("mobile.publicEmail")}</Label>
									<Input
										autoCapitalize="none"
										autoComplete="email"
										autoCorrect="off"
										disabled={busy}
										inputMode="email"
										type="email"
										value={email}
										onChange={(event) => {
											setEmail(event.target.value);
											setError(null);
										}}
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label>{t("mobile.publicPassword")}</Label>
									<Input
										autoComplete={step === "register" ? "new-password" : "current-password"}
										disabled={busy}
										type="password"
										value={password}
										onChange={(event) => {
											setPassword(event.target.value);
											setError(null);
										}}
									/>
									{step === "register" ? (
										<p className="text-xs text-muted-foreground">{t("mobile.publicPasswordHint")}</p>
									) : null}
								</div>
								{step === "register" ? (
									<div className="flex flex-col gap-1">
										<Label>{t("mobile.publicConfirmPassword")}</Label>
										<Input
											autoComplete="new-password"
											disabled={busy}
											type="password"
											value={confirm}
											onChange={(event) => {
												setConfirm(event.target.value);
												setError(null);
											}}
										/>
										{mismatch ? (
											<p className="text-xs text-destructive">{t("mobile.publicPasswordMismatch")}</p>
										) : null}
									</div>
								) : null}
							</>
						)}
						</div>
					</form>
					{error ? (
						<p role="alert" className="shrink-0 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
							{error}
						</p>
					) : null}
					{notice ? (
						<p role="status" className="shrink-0 rounded-lg bg-emerald-500/10 p-2.5 text-xs text-emerald-600 dark:text-emerald-400">
							{notice}
						</p>
					) : null}
					<div className="flex shrink-0 items-center justify-between gap-2">
						<div>
							{step === "login" ? (
								<button
									type="button"
									disabled={busy}
									className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
									onClick={() => switchStep("register")}
								>
									{t("mobile.publicNoAccount")}
								</button>
							) : null}
							{step === "register" ? (
								<button
									type="button"
									disabled={busy}
									className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
									onClick={() => switchStep("login")}
								>
									{t("mobile.publicHaveAccount")}
								</button>
							) : null}
							{step === "verify" ? (
								<button
									type="button"
									disabled={busy}
									className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
									onClick={() => switchStep("login")}
								>
									{t("mobile.publicBackToLogin")}
								</button>
							) : null}
						</div>
						<div className="flex items-center gap-2">
							{step === "verify" ? (
								<Button
									disabled={busy || cooldown > 0}
									size="sm"
									variant="ghost"
									onClick={() =>
										void run(async () => {
											await onResend({ email: trimmedEmail });
											setNotice(t("mobile.publicCodeResent"));
											setCooldown(60);
										})
									}
								>
									{cooldown > 0 ? t("mobile.publicResendIn", { seconds: cooldown }) : t("mobile.publicResend")}
								</Button>
							) : null}
							<Button disabled={busy} onClick={onClose} size="sm" variant="ghost">
								{t("common.cancel")}
							</Button>
							<Button disabled={busy || !submitEnabled} form="relay-account-form" size="sm" type="submit" variant="subtle">
								{busy ? busyLabel : actionLabel}
							</Button>
						</div>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
