import { createTransport, type Transporter } from "nodemailer";
import type { Env } from "../env";

/**
 * Outbound mail.
 *
 * One pooled connection rather than one per send: a verification code goes out
 * on a request the user is waiting on, and a fresh TLS handshake to the mail
 * server on every registration is latency nobody needs.
 */
export interface Mailer {
	sendVerificationCode(to: string, code: string, minutes: number): Promise<void>;
	sendPasswordResetCode(to: string, code: string, minutes: number): Promise<void>;
	close(): Promise<void>;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function layout(title: string, body: string): string {
	return `<!doctype html><html lang="zh-CN"><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1c1917">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<h1 style="margin:0 0 16px;font-size:18px">${escapeHtml(title)}</h1>
${body}
<p style="margin:24px 0 0;font-size:12px;color:#78716c">这封邮件由 NekoCode 自动发送，请勿直接回复。</p>
</div></body></html>`;
}

export function createMailer(env: Env): Mailer {
	const transport: Transporter = createTransport({
		host: env.smtp.host,
		port: env.smtp.port,
		// 465 is implicit TLS; 587 and 25 start plaintext and upgrade via STARTTLS.
		secure: env.smtp.port === 465,
		auth: { user: env.smtp.user, pass: env.smtp.pass },
		pool: true,
		maxConnections: 3,
		requireTLS: env.smtp.port !== 465,
		tls: { rejectUnauthorized: !env.smtp.allowSelfSigned },
	});

	const send = async (to: string, subject: string, html: string, text: string) => {
		await transport.sendMail({ from: env.smtp.from, to, subject, html, text });
	};

	return {
		async sendVerificationCode(to, code, minutes) {
			const spaced = code.split("").join(" ");
			await send(
				to,
				`NekoCode 验证码 ${code}`,
				layout(
					"验证你的邮箱",
					`<p style="margin:0 0 20px;font-size:14px;line-height:1.7">在 NekoCode 中输入下面的验证码完成验证：</p>
<div style="font-size:30px;font-weight:600;letter-spacing:.32em;text-align:center;padding:18px;background:#f5f5f4;border-radius:10px">${escapeHtml(code)}</div>
<p style="margin:20px 0 0;font-size:13px;color:#57534e;line-height:1.7">验证码 ${String(minutes)} 分钟内有效，仅可使用一次。<br>如果这不是你本人的操作，忽略这封邮件即可，你的邮箱不会被注册。</p>`,
				),
				`NekoCode 验证码：${spaced}\n\n${String(minutes)} 分钟内有效，仅可使用一次。\n如果这不是你本人的操作，忽略这封邮件即可。`,
			);
		},
		async sendPasswordResetCode(to, code, minutes) {
			const spaced = code.split("").join(" ");
			await send(
				to,
				`NekoCode 密码重置验证码 ${code}`,
				layout(
					"重置你的密码",
					`<p style="margin:0 0 20px;font-size:14px;line-height:1.7">在 NekoCode 中输入下面的验证码重置密码：</p>
<div style="font-size:30px;font-weight:600;letter-spacing:.32em;text-align:center;padding:18px;background:#f5f5f4;border-radius:10px">${escapeHtml(code)}</div>
<p style="margin:20px 0 0;font-size:13px;color:#57534e;line-height:1.7">验证码 ${String(minutes)} 分钟内有效，仅可使用一次。<br>如果不是本人操作，忽略即可，你的密码不会被修改。</p>`,
				),
				`NekoCode 密码重置验证码：${spaced}\n\n${String(minutes)} 分钟内有效，仅可使用一次。\n如果不是本人操作，忽略即可，你的密码不会被修改。`,
			);
		},
		close: () => {
			transport.close();
			return Promise.resolve();
		},
	};
}
