import {
	retryDelay,
	type QqAttachment,
	type QqCapabilities,
	type QqChat,
	type QqConnection,
	type QqConnectionHooks,
	type QqMessage,
	type QqReply,
	type QqStream,
} from "./protocol";

interface OneBotOptions {
	/** `ws://host:port` the implementation serves its event stream on. */
	url: string;
	accessToken: string;
}

/** A `[CQ:at,qq=123]` mention, which is how OneBot marks who a message addresses. */
const CQ_AT = /\[CQ:at,[^\]]*qq=(\d+|all)[^\]]*\]/g;
const CQ_ANY = /\[CQ:[^\]]*\]/g;

interface Segment {
	type: string;
	data?: Record<string, unknown>;
}

/**
 * A bot backend the user already runs, spoken to over OneBot v11.
 *
 * The desktop is the client: NapCat and friends serve a "正向 WebSocket" and the
 * app dials it, so nothing here has to be reachable from outside this machine.
 * Redials on its own because that socket's usual failure is its backend still
 * booting, not a configuration mistake worth stopping for.
 */
export class OneBotConnection implements QqConnection {
	/**
	 * Images go out as CQ codes, which every implementation understands. Buttons
	 * and streaming are the official platform's, and OneBot has no equivalent to
	 * fake convincingly — the service degrades instead.
	 */
	readonly capabilities: QqCapabilities = { stream: false, buttons: false, files: true, markdown: false };
	private socket: WebSocket | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private attempt = 0;
	private closed = false;
	private echo = 0;
	private selfId = "";
	self: string | undefined;

	constructor(
		private readonly options: OneBotOptions,
		private readonly hooks: QqConnectionHooks,
	) {
		this.dial();
	}

	private endpoint(): string {
		const url = new URL(this.options.url);
		if (url.protocol !== "ws:" && url.protocol !== "wss:") {
			throw new Error("地址需以 ws:// 或 wss:// 开头");
		}
		// Carried in the query rather than a header: the WebSocket API browsers and
		// Node share has no way to set one, and OneBot accepts both.
		if (this.options.accessToken) url.searchParams.set("access_token", this.options.accessToken);
		return url.toString();
	}

	private dial(): void {
		if (this.closed) return;
		let endpoint: string;
		try {
			endpoint = this.endpoint();
		} catch (error) {
			this.hooks.onState("error", message(error));
			return;
		}
		this.hooks.onState("connecting");
		let socket: WebSocket;
		try {
			socket = new WebSocket(endpoint);
		} catch (error) {
			this.fail(message(error));
			return;
		}
		this.socket = socket;
		socket.addEventListener("open", () => {
			if (this.socket !== socket) return;
			this.attempt = 0;
			this.hooks.onState("ready");
		});
		socket.addEventListener("message", (event: MessageEvent) => {
			if (this.socket !== socket) return;
			this.consume(event.data);
		});
		// `error` fires before `close` on a refused socket and carries no reason of
		// its own, so the close below is what reports; this only keeps Node from
		// treating the event as unhandled.
		socket.addEventListener("error", () => undefined);
		socket.addEventListener("close", (event: CloseEvent) => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.fail(closeReason(event));
		});
	}

	private fail(reason: string): void {
		if (this.closed) return;
		this.hooks.onState("error", reason);
		const delay = retryDelay(this.attempt++);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.dial();
		}, delay);
	}

	private consume(raw: unknown): void {
		if (typeof raw !== "string") return;
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") return;
			event = parsed as Record<string, unknown>;
		} catch {
			// Not JSON: an implementation writing something else down the same socket.
			return;
		}
		if (typeof event.self_id === "number" || typeof event.self_id === "string") {
			const id = String(event.self_id);
			if (id !== this.selfId) this.hooks.onTrace(`OneBot 已识别机器人账号 QQ ${id}`);
			this.selfId = id;
			this.self = `QQ ${this.selfId}`;
		}
		if (event.post_type !== "message") return;
		const parsed = oneBotMessage(event, this.selfId);
		if (parsed) this.hooks.onMessage(parsed);
		// A group message that named nobody is the ordinary case and not worth a
		// line; one that named someone else is what a missed `@` looks like.
		else this.hooks.onTrace(`已忽略消息（message_type=${String(event.message_type)}）`);
	}

	async send(chat: QqChat, reply: QqReply): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("QQ 连接已断开");
		const params =
			chat.kind === "private"
				? { message_type: "private", user_id: Number(chat.id) || chat.id }
				: { message_type: "group", group_id: Number(chat.id) || chat.id };
		// Text and files in one message: a CQ code inline with the text is how
		// OneBot carries an image, not a second send.
		const segments = [
			reply.text,
			...(reply.files ?? []).map((file) => {
				// `base64://` for bytes, so a rendered image needs no temp file at all.
				// `file://` for a local path is what implementations expect; a bare
				// Windows path is read as a relative name inside their own data dir.
				const uri = file.buffer
					? `base64://${file.buffer.toString("base64")}`
					: file.path
						? `file:///${file.path.replace(/\\/g, "/").replace(/^\/+/, "")}`
						: (file.url ?? "");
				if (!uri) return "";
				return file.kind === "image" ? `[CQ:image,file=${uri}]` : `[CQ:file,file=${uri}]`;
			}),
		].filter(Boolean);
		socket.send(
			JSON.stringify({
				action: "send_msg",
				params: { ...params, message: segments.join("\n") },
				echo: `nekocode-${++this.echo}`,
			}),
		);
	}

	/** OneBot has no streaming message; the service falls back to whole replies. */
	openStream(): QqStream | null {
		return null;
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const socket = this.socket;
		this.socket = null;
		socket?.close();
	}
}

/**
 * Turn one OneBot message event into a message, or nothing if it is neither a
 * private nor a group message.
 *
 * Exported for tests: `addressed` is what decides whether a group message is
 * acted on, and it is worth pinning down apart from a live socket.
 */
export function oneBotMessage(event: Record<string, unknown>, selfId: string): QqMessage | null {
	const sender = (event.sender ?? {}) as Record<string, unknown>;
	const senderId = String(event.user_id ?? "");
	if (!senderId) return null;
	const senderName =
		[sender.card, sender.nickname].find((name) => typeof name === "string" && name.trim()) ?? senderId;
	const { text, mentions, attachments } = decode(event);
	const extras = {
		...(attachments.length ? { attachments } : {}),
		// `message_id` rather than a reply token: OneBot needs no association to
		// send, but the id is what a quote points back at.
		...(event.message_id != null ? { replyToken: String(event.message_id) } : {}),
	};
	if (event.message_type === "private") {
		return {
			chat: { kind: "private", id: senderId },
			senderId,
			senderName: String(senderName),
			text,
			addressed: true,
			...extras,
		};
	}
	if (event.message_type !== "group" || event.group_id == null) return null;
	return {
		chat: { kind: "group", id: String(event.group_id) },
		senderId,
		senderName: String(senderName),
		text,
		// `all` counts: an @全体成员 that names a task is still addressed here, and
		// the group allowlist is what decides whether it is acted on.
		addressed: mentions.has(selfId) || mentions.has("all"),
		...extras,
	};
}

/**
 * Pull the plain text, the mentions and the files out of a message.
 *
 * Implementations send either an array of segments or a CQ-coded string
 * depending on how they were configured, and which one arrives is not something
 * this app gets to choose — so both are read. Only the segment form carries
 * file URLs; a CQ string names a file the implementation holds, not one this
 * app could fetch.
 */
function decode(event: Record<string, unknown>): {
	text: string;
	mentions: Set<string>;
	attachments: QqAttachment[];
} {
	const mentions = new Set<string>();
	const attachments: QqAttachment[] = [];
	if (Array.isArray(event.message)) {
		const parts: string[] = [];
		for (const segment of event.message as Segment[]) {
			if (!segment || typeof segment !== "object") continue;
			if (segment.type === "text" && typeof segment.data?.text === "string") {
				parts.push(segment.data.text);
			}
			if (segment.type === "at" && segment.data?.qq != null) mentions.add(String(segment.data.qq));
			const url = segment.data?.url ?? segment.data?.file;
			if ((segment.type === "image" || segment.type === "file") && typeof url === "string" && /^https?:/.test(url)) {
				attachments.push({
					kind: segment.type === "image" ? "image" : "file",
					url,
					...(typeof segment.data?.file === "string" ? { name: segment.data.file } : {}),
				});
			}
		}
		return { text: parts.join("").trim(), mentions, attachments };
	}
	const raw = typeof event.raw_message === "string" ? event.raw_message : "";
	for (const match of raw.matchAll(CQ_AT)) mentions.add(match[1]);
	return { text: raw.replace(CQ_ANY, " ").trim(), mentions, attachments };
}

function closeReason(event: CloseEvent): string {
	if (event.reason) return `连接已关闭：${event.reason}`;
	// 1006 is what a refused or dropped socket reports, and it is by far the most
	// common one here — a backend that is not listening on the configured port.
	if (event.code === 1006) return "无法连接到 OneBot 服务，请检查地址、端口和 access_token";
	return `连接已关闭（code ${String(event.code)}）`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
