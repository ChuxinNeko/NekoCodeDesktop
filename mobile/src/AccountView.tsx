import { useEffect, useRef, useState } from "react";
import { Button } from "../../src/renderer/src/components/ui/button";
import { Input } from "../../src/renderer/src/components/ui/input";
import { account, AccountError } from "./account-client";

/**
 * The NekoCode account screen: sign in, register, redeem the emailed code, and
 * reset a forgotten password.
 *
 * One component for all of them because they are one flow with shared state —
 * the address and password carry across, and registering lands on the code step
 * with both already filled in. Splitting them would mean lifting that state
 * somewhere just to hand it back down.
 */

type Step = "signin" | "register" | "verify" | "forgot" | "reset";

/** Matches the server's own cooldown, so the button unlocks when a resend works. */
const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;

export function AccountView({ onSignedIn }: { onSignedIn: (email: string) => void }) {
	const [step, setStep] = useState<Step>("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [cooldown, setCooldown] = useState(0);
	const codeInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (cooldown <= 0) return;
		const timer = setInterval(() => setCooldown((left) => Math.max(0, left - 1)), 1000);
		return () => clearInterval(timer);
	}, [cooldown]);

	// The code step is the only one where the field to fill is not the first, so
	// it is the only one worth moving focus for.
	useEffect(() => {
		if (step === "verify" || step === "reset") codeInput.current?.focus();
	}, [step]);

	const go = (next: Step) => {
		setStep(next);
		setError(null);
		setNotice(null);
	};

	/** Every submit is the same shape: clear, run, translate the failure. */
	const run = async (action: () => Promise<void>) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			if (cause instanceof AccountError) {
				// The password was right but the address was never confirmed, and the
				// server has just sent a fresh code — that is a step forward, not a
				// failure, so the screen follows it.
				if (cause.code === "email_unverified") {
					setError(null);
					setNotice("这个邮箱还没验证，验证码已重新发送");
					setCooldown(RESEND_COOLDOWN_SECONDS);
					setStep("verify");
				}
				// Already registered: the one thing to do is sign in, so offer that
				// rather than leaving them on a form that cannot succeed.
				if (cause.code === "email_taken") setStep("signin");
			}
		} finally {
			setBusy(false);
		}
	};

	const signIn = () =>
		run(async () => {
			const user = await account.login(email, password);
			onSignedIn(user.email);
		});

	const register = () =>
		run(async () => {
			await account.register(email, password);
			setNotice(`验证码已发送到 ${email.trim()}`);
			setCooldown(RESEND_COOLDOWN_SECONDS);
			setCode("");
			setStep("verify");
		});

	const verify = () =>
		run(async () => {
			const user = await account.verify(email, code);
			onSignedIn(user.email);
		});

	const resend = () =>
		run(async () => {
			await account.resend(email);
			setNotice("验证码已重新发送");
			setCooldown(RESEND_COOLDOWN_SECONDS);
		});

	const forgot = () =>
		run(async () => {
			await account.forgot(email);
			setNotice(`如果该邮箱已注册，验证码已发送到 ${email.trim()}`);
			setCooldown(RESEND_COOLDOWN_SECONDS);
			setCode("");
			setPassword("");
			setConfirm("");
			setStep("reset");
		});

	const resendReset = () =>
		run(async () => {
			await account.forgot(email);
			setNotice(`如果该邮箱已注册，验证码已发送到 ${email.trim()}`);
			setCooldown(RESEND_COOLDOWN_SECONDS);
		});

	const reset = () =>
		run(async () => {
			if (password !== confirm) {
				setError("两次输入的密码不一致");
				return;
			}
			await account.reset(email, code, password);
			setCode("");
			setPassword("");
			setConfirm("");
			setStep("signin");
			setNotice("密码已重置，请使用新密码登录");
		});

	const emailOk = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email.trim());
	const passwordOk = password.length >= 8;
	const resetOk = emailOk && code.length === CODE_LENGTH && passwordOk && password === confirm;

	if (step === "verify") {
		return (
			<form
				className="flex flex-col gap-5"
				onSubmit={(event) => {
					event.preventDefault();
					void verify();
				}}
			>
				<div>
					<h2 className="text-base font-medium">输入验证码</h2>
					<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
						我们向 <span className="text-foreground">{email.trim()}</span> 发送了 6 位验证码，10 分钟内有效。
					</p>
				</div>
				<Input
					ref={codeInput}
					className="h-14 text-center font-mono text-2xl tracking-[0.4em]"
					inputMode="numeric"
					autoComplete="one-time-code"
					maxLength={CODE_LENGTH}
					placeholder="000000"
					value={code}
					disabled={busy}
					onChange={(event) => {
						// Digits only, so a pasted "1 2 3 4 5 6" still works.
						const digits = event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH);
						setCode(digits);
						setError(null);
					}}
				/>
				<Button type="submit" className="h-12" disabled={busy || code.length !== CODE_LENGTH}>
					{busy ? "正在验证…" : "验证并登录"}
				</Button>
				<div className="flex items-center justify-between text-sm">
					<button
						type="button"
						className="text-muted-foreground disabled:opacity-50"
						disabled={busy || cooldown > 0}
						onClick={() => void resend()}
					>
						{cooldown > 0 ? `${String(cooldown)} 秒后可重发` : "重新发送验证码"}
					</button>
					<button type="button" className="text-muted-foreground" onClick={() => go("signin")}>
						返回登录
					</button>
				</div>
				{notice && <p className="text-sm leading-relaxed text-muted-foreground">{notice}</p>}
				{error && (
					<p role="alert" className="text-sm leading-relaxed text-destructive">
						{error}
					</p>
				)}
				<p className="text-xs leading-relaxed text-muted-foreground">
					没收到？检查垃圾邮件文件夹，或确认邮箱地址是否输错。验证码错误 5 次后需要重新获取。
				</p>
			</form>
		);
	}

	if (step === "forgot") {
		return (
			<form
				className="flex flex-col gap-5"
				onSubmit={(event) => {
					event.preventDefault();
					void forgot();
				}}
			>
				<div>
					<h2 className="text-base font-medium">忘记密码</h2>
					<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
						输入注册时用的邮箱，我们会发送 6 位验证码用于重置密码。
					</p>
				</div>
				<label className="flex flex-col gap-2 text-sm">
					邮箱
					<Input
						className="h-11 text-base"
						type="email"
						inputMode="email"
						autoCapitalize="none"
						autoCorrect="off"
						autoComplete="email"
						placeholder="you@example.com"
						value={email}
						disabled={busy}
						onChange={(event) => {
							setEmail(event.target.value);
							setError(null);
						}}
						required
					/>
				</label>
				<Button type="submit" className="h-12" disabled={busy || !emailOk}>
					{busy ? "正在发送…" : "发送验证码"}
				</Button>
				<button type="button" className="text-sm text-muted-foreground" disabled={busy} onClick={() => go("signin")}>
					返回登录
				</button>
				{notice && <p className="text-sm leading-relaxed text-muted-foreground">{notice}</p>}
				{error && (
					<p role="alert" className="text-sm leading-relaxed text-destructive">
						{error}
					</p>
				)}
			</form>
		);
	}

	if (step === "reset") {
		return (
			<form
				className="flex flex-col gap-5"
				onSubmit={(event) => {
					event.preventDefault();
					void reset();
				}}
			>
				<div>
					<h2 className="text-base font-medium">重置密码</h2>
					<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
						如果 <span className="text-foreground">{email.trim()}</span> 已注册，验证码已发送，10 分钟内有效。
					</p>
				</div>
				<Input
					ref={codeInput}
					className="h-14 text-center font-mono text-2xl tracking-[0.4em]"
					inputMode="numeric"
					autoComplete="one-time-code"
					maxLength={CODE_LENGTH}
					placeholder="000000"
					value={code}
					disabled={busy}
					onChange={(event) => {
						const digits = event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH);
						setCode(digits);
						setError(null);
					}}
				/>
				<label className="flex flex-col gap-2 text-sm">
					新密码
					<Input
						className="h-11 text-base"
						type="password"
						autoCapitalize="none"
						autoComplete="new-password"
						placeholder="至少 8 位"
						value={password}
						disabled={busy}
						onChange={(event) => {
							setPassword(event.target.value);
							setError(null);
						}}
						required
					/>
				</label>
				<label className="flex flex-col gap-2 text-sm">
					确认新密码
					<Input
						className="h-11 text-base"
						type="password"
						autoCapitalize="none"
						autoComplete="new-password"
						value={confirm}
						disabled={busy}
						onChange={(event) => {
							setConfirm(event.target.value);
							setError(null);
						}}
						required
					/>
				</label>
				{confirm.length > 0 && password !== confirm && (
					<p role="alert" className="text-sm leading-relaxed text-destructive">
						两次输入的密码不一致
					</p>
				)}
				<Button type="submit" className="h-12" disabled={busy || !resetOk}>
					{busy ? "正在重置…" : "重置密码"}
				</Button>
				<div className="flex items-center justify-between text-sm">
					<button
						type="button"
						className="text-muted-foreground disabled:opacity-50"
						disabled={busy || cooldown > 0}
						onClick={() => void resendReset()}
					>
						{cooldown > 0 ? `${String(cooldown)} 秒后可重发` : "重新发送验证码"}
					</button>
					<button type="button" className="text-muted-foreground" onClick={() => go("signin")}>
						返回登录
					</button>
				</div>
				{notice && <p className="text-sm leading-relaxed text-muted-foreground">{notice}</p>}
				{error && (
					<p role="alert" className="text-sm leading-relaxed text-destructive">
						{error}
					</p>
				)}
			</form>
		);
	}

	const registering = step === "register";
	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(event) => {
				event.preventDefault();
				void (registering ? register() : signIn());
			}}
		>
			<div>
				<h2 className="text-base font-medium">{registering ? "注册 NekoCode 账号" : "登录 NekoCode 账号"}</h2>
				<p className="mt-2 text-sm leading-relaxed text-muted-foreground">
					{registering ? "用邮箱注册，验证后即可通过公网连接你的电脑。" : "登录后即可通过公网连接你的电脑。"}
				</p>
			</div>
			<label className="flex flex-col gap-2 text-sm">
				邮箱
				<Input
					className="h-11 text-base"
					type="email"
					inputMode="email"
					autoCapitalize="none"
					autoCorrect="off"
					autoComplete="email"
					placeholder="you@example.com"
					value={email}
					disabled={busy}
					onChange={(event) => {
						setEmail(event.target.value);
						setError(null);
					}}
					required
				/>
			</label>
			<label className="flex flex-col gap-2 text-sm">
				密码
				<Input
					className="h-11 text-base"
					type="password"
					autoCapitalize="none"
					autoComplete={registering ? "new-password" : "current-password"}
					placeholder={registering ? "至少 8 位" : ""}
					value={password}
					disabled={busy}
					onChange={(event) => {
						setPassword(event.target.value);
						setError(null);
					}}
					required
				/>
			</label>
			<Button type="submit" className="h-12" disabled={busy || !emailOk || !passwordOk}>
				{busy ? (registering ? "正在注册…" : "正在登录…") : registering ? "注册" : "登录"}
			</Button>
			{notice && <p className="text-sm leading-relaxed text-muted-foreground">{notice}</p>}
			{error && (
				<p role="alert" className="text-sm leading-relaxed text-destructive">
					{error}
				</p>
			)}
			{!registering && (
				<button
					type="button"
					className="text-sm text-muted-foreground"
					disabled={busy}
					onClick={() => go("forgot")}
				>
					忘记密码？
				</button>
			)}
			<button
				type="button"
				className="text-sm text-muted-foreground"
				disabled={busy}
				onClick={() => go(registering ? "signin" : "register")}
			>
				{registering ? "已有账号？去登录" : "还没有账号？去注册"}
			</button>
		</form>
	);
}

/** What the account tab shows once someone is signed in. */
export function AccountCard({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
	const [busy, setBusy] = useState(false);
	return (
		<section className="flex flex-col gap-5">
			<div className="rounded-xl border border-border px-5 py-6">
				<p className="text-sm text-muted-foreground">已登录</p>
				<p className="mt-1 break-all text-base">{email}</p>
			</div>
			<p className="text-sm leading-relaxed text-muted-foreground">
				公网连接与局域网配对相互独立。消息端到端加密，服务器正常只转发密文；设备公钥由账号服务分发，主动替换公钥的服务器仍可能发起中间人攻击。
			</p>
			<Button
				variant="subtle"
				className="h-11"
				disabled={busy}
				onClick={() => {
					setBusy(true);
					void account.logout().finally(() => {
						setBusy(false);
						onSignedOut();
					});
				}}
			>
				退出登录
			</Button>
		</section>
	);
}
