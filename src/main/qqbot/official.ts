import type {
	InlineKeyboard,
	QQBot,
	QQBotInboundMessage,
	ReplyTarget,
	StreamSession,
} from "@tencent-connect/qqbot-nodejs";
import {
	retryDelay,
	type QqAction,
	type QqAttachment,
	type QqCapabilities,
	type QqChat,
	type QqConnection,
	type QqConnectionHooks,
	type QqMessage,
	type QqReply,
	type QqStream,
} from "./protocol";

interface OfficialOptions {
	appId: string;
	appSecret: string;
	/** Dial the sandbox gateway instead of production — separate bot, separate data. */
	sandbox: boolean;
	/** The bot was granted 原生 Markdown on q.qq.com. */
	markdown: boolean;
}

const SANDBOX_API = "https://sandbox.api.sgroup.qq.com";

/**
 * Load the SDK out of the bundler's sight.
 *
 * `@tencent-connect/qqbot-nodejs` is ESM-only and the main process builds to
 * CommonJS, where Rollup rewrites a dynamic `import()` of an external package
 * into `require()` — which throws `ERR_REQUIRE_ESM` at runtime. Going through
 * `Function` keeps it a real dynamic import that Node resolves itself.
 */
const esmImport = new Function("specifier", "return import(specifier)") as (
	specifier: string,
) => Promise<typeof import("@tencent-connect/qqbot-nodejs")>;

/** Buttons: an action button, usable by anyone, that echoes its data back. */
const BUTTON_ACTION_TYPE = 2;
const BUTTON_PERMISSION_EVERYONE = 2;

/**
 * A bot registered on the QQ 机器人开放平台.
 *
 * Thin by design: the protocol underneath — token refresh, gateway heartbeat and
 * RESUME, `msg_seq` bookkeeping per reply, chunked media upload, streaming
 * frames — is the official SDK's, not this app's. What is left here is the
 * mapping between that SDK's vocabulary and this app's `QqConnection`.
 *
 * Redials on its own, because the SDK's `start()` resolves when the transport
 * ends and a bot that quietly stopped receiving is the failure people notice
 * last.
 */
export class OfficialConnection implements QqConnection {
	readonly capabilities: QqCapabilities;
	private bot: QQBot | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private attempt = 0;
	private closed = false;
	self: string | undefined;

	constructor(
		private readonly options: OfficialOptions,
		private readonly hooks: QqConnectionHooks,
	) {
		this.capabilities = { stream: true, buttons: true, files: true, markdown: options.markdown };
		void this.dial();
	}

	private async dial(): Promise<void> {
		if (this.closed) return;
		if (!this.options.appId || !this.options.appSecret) {
			this.hooks.onState("error", "请填写 AppID 和 AppSecret");
			return;
		}
		this.hooks.onState("connecting");

		let bot: QQBot;
		try {
			const { QQBot } = await esmImport("@tencent-connect/qqbot-nodejs");
			if (this.closed) return;
			bot = new QQBot({
				appId: this.options.appId,
				appSecret: this.options.appSecret,
				// Decides whether `sendText` goes out as msg_type=2. Wrong-way-round
				// is a rejected send, not a fallback, so it mirrors the user's claim
				// about the permission rather than being assumed.
				markdownSupport: this.options.markdown,
				// Sandbox is a different API host; everything else is identical.
				...(this.options.sandbox ? { baseUrl: SANDBOX_API } : {}),
				logger: {
					debug: () => undefined,
					info: () => undefined,
					warn: (...args: unknown[]) => this.hooks.onTrace(line(args)),
					error: (...args: unknown[]) => this.hooks.onTrace(line(args)),
				},
			});
		} catch (error) {
			this.fail(message(error));
			return;
		}
		this.bot = bot;

		bot.on("ready", () => {
			this.attempt = 0;
			this.self = `AppID ${this.options.appId}`;
			this.hooks.onState("ready");
		});
		bot.on("resumed", () => this.hooks.onTrace("网关会话已恢复"));
		bot.on("error", (error: Error) => this.hooks.onTrace(`SDK 报错：${error.message}`));
		bot.on("message", (_ctx, msg) => {
			const parsed = toMessage(msg);
			if (parsed) this.hooks.onMessage(parsed);
			else this.hooks.onTrace(`已忽略消息（kind=${msg.kind}）`);
		});
		bot.on("interaction", (_ctx, event) => {
			const resolved = event.data?.resolved;
			const chat = interactionChat(event);
			if (!chat || !resolved?.button_data) {
				this.hooks.onTrace("已忽略无法归属的按钮事件");
				return;
			}
			// Acknowledged first: an unacknowledged button spins in the client until
			// it times out, whatever this app then decides to do about it.
			void bot.acknowledgeInteraction(event.id).catch((error: unknown) => {
				this.hooks.onTrace(`按钮回执失败：${message(error)}`);
			});
			this.hooks.onInteraction({
				chat,
				senderId: event.group_member_openid ?? event.user_openid ?? "",
				actionId: resolved.button_id ?? "",
				data: resolved.button_data,
				interactionId: event.id,
			});
		});

		try {
			// Resolves when the transport ends — normally only on `stop()`.
			await bot.start();
			if (!this.closed) this.fail("网关连接已结束");
		} catch (error) {
			this.fail(message(error));
		}
	}

	private fail(reason: string): void {
		if (this.closed) return;
		this.bot?.stop();
		this.bot = null;
		this.hooks.onState("error", reason);
		const delay = retryDelay(this.attempt++);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.dial();
		}, delay);
	}

	private target(chat: QqChat, replyToken?: string): ReplyTarget {
		return {
			scope: chat.kind === "private" ? "c2c" : "group",
			targetId: chat.id,
			...(replyToken ? { msgId: replyToken } : {}),
		};
	}

	async send(chat: QqChat, reply: QqReply, replyToken?: string): Promise<void> {
		const bot = this.bot;
		if (!bot) throw new Error("QQ 连接已断开");
		// Guild channels are a different endpoint family the SDK keeps apart, and
		// they take neither keyboards nor uploads through this path.
		if (chat.kind === "channel") {
			await bot.sendChannelMessage(chat.id, reply.text, replyToken ? { msgId: replyToken } : {});
			return;
		}
		const target = this.target(chat, replyToken);
		const keyboard = toKeyboard(reply.actions);
		if (keyboard) await bot.sendTextWithKeyboard(target, reply.text, keyboard);
		else await bot.sendText(target, reply.text);

		for (const file of reply.files ?? []) {
			const { MediaFileType } = await esmImport("@tencent-connect/qqbot-nodejs");
			const fileType =
				file.kind === "image"
					? MediaFileType.IMAGE
					: file.kind === "video"
						? MediaFileType.VIDEO
						: MediaFileType.FILE;
			try {
				await bot.sendMedia({
					target,
					fileType,
					...(file.buffer
						? { buffer: file.buffer }
						: file.path
							? { localPath: file.path }
							: { url: file.url }),
					...(file.name ? { fileName: file.name } : {}),
				});
			} catch (error) {
				// One unsendable attachment must not lose the answer it came with —
				// the text above has already gone out.
				this.hooks.onTrace(`附件发送失败（${file.name ?? file.path ?? file.url ?? "?"}）：${message(error)}`);
			}
		}
	}

	openStream(chat: QqChat, replyToken?: string): QqStream | null {
		const bot = this.bot;
		// C2C only on the platform's side; a group stream would be rejected frame
		// by frame, which is worse than never having opened one.
		if (!bot || chat.kind !== "private") return null;
		let session: StreamSession;
		try {
			session = bot.openStream({ target: this.target(chat, replyToken), throttleMs: 1200 });
		} catch (error) {
			this.hooks.onTrace(`无法开启流式回复：${message(error)}`);
			return null;
		}
		return {
			update: (text) => session.update(text),
			complete: async (text) => {
				await session.update(text);
				await session.complete();
			},
			cancel: () => session.cancel(),
		};
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.bot?.stop();
		this.bot = null;
	}
}

/**
 * Map the SDK's inbound message onto this app's.
 *
 * `guild` and `dm` are carried as `channel` so a 频道 bot keeps working, but the
 * two ids the SDK reports for them are not interchangeable — a DM answers on the
 * guild, a channel message on the channel.
 *
 * Exported for tests: the protocol below is the SDK's business now, but this
 * mapping is still ours and is where a quote or an attachment goes missing.
 */
export function toMessage(msg: QQBotInboundMessage): QqMessage | null {
	const chat: QqChat | null =
		msg.kind === "c2c"
			? { kind: "private", id: msg.replyTarget.targetId }
			: msg.kind === "group"
				? { kind: "group", id: msg.groupOpenid ?? msg.replyTarget.targetId }
				: msg.channelId
					? { kind: "channel", id: msg.channelId }
					: null;
	if (!chat) return null;
	// A bot answering its own output is a loop with a monthly bill attached.
	if (msg.senderIsBot) return null;

	const quoted = msg.msgElements?.[0];
	return {
		chat,
		senderId: msg.senderId,
		senderName: msg.senderName?.trim() || msg.senderId,
		text: msg.content.replace(/<@!?\w+>/g, " ").trim(),
		// Every event the SDK surfaces as a message is one the bot was meant to
		// see: the platform only pushes group messages that mentioned it.
		addressed: true,
		replyToken: msg.messageId,
		...(msg.attachments?.length ? { attachments: msg.attachments.map(toAttachment) } : {}),
		...(quoted?.content || quoted?.attachments?.length
			? {
					quote: {
						text: (quoted.content ?? "").trim(),
						...(quoted.attachments?.length ? { attachments: quoted.attachments.map(toAttachment) } : {}),
					},
				}
			: {}),
	};
}

function toAttachment(raw: {
	content_type: string;
	url: string;
	filename?: string;
	asr_refer_text?: string;
}): QqAttachment {
	const type = raw.content_type || "";
	const kind = type.startsWith("image/")
		? "image"
		: type.startsWith("video/")
			? "video"
			: type.startsWith("audio/") || type.startsWith("voice")
				? "voice"
				: "file";
	return {
		kind,
		url: raw.url,
		...(raw.filename ? { name: raw.filename } : {}),
		...(type ? { contentType: type } : {}),
		...(raw.asr_refer_text ? { transcript: raw.asr_refer_text } : {}),
	};
}

function interactionChat(event: {
	group_openid?: string;
	user_openid?: string;
	channel_id?: string;
}): QqChat | null {
	if (event.group_openid) return { kind: "group", id: event.group_openid };
	if (event.user_openid) return { kind: "private", id: event.user_openid };
	if (event.channel_id) return { kind: "channel", id: event.channel_id };
	return null;
}

/** QQ lays buttons out in rows; two per row keeps the labels readable on a phone. */
export function toKeyboard(actions: QqAction[] | undefined): InlineKeyboard | undefined {
	if (!actions?.length) return undefined;
	const rows: InlineKeyboard["content"]["rows"] = [];
	for (let at = 0; at < actions.length; at += 2) {
		rows.push({
			buttons: actions.slice(at, at + 2).map((action) => ({
				id: action.id,
				render_data: { label: action.label, visited_label: action.label, style: 1 },
				action: {
					type: BUTTON_ACTION_TYPE,
					permission: { type: BUTTON_PERMISSION_EVERYONE },
					data: action.data,
				},
			})),
		});
	}
	return { content: { rows } };
}

function line(args: unknown[]): string {
	return args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
