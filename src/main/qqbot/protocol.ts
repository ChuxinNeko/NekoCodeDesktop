/**
 * Where a message came from, and where its answer goes back to.
 *
 * `private` is a one-to-one chat, `group` a QQ group, `channel` a 频道 channel
 * on the official platform. OneBot only ever produces the first two.
 */
export interface QqChat {
	kind: "private" | "group" | "channel";
	/** The QQ number, group number, or the openid the platform uses instead. */
	id: string;
}

/** A file that came in with a message, or is going out with a reply. */
export interface QqAttachment {
	kind: "image" | "video" | "voice" | "file";
	url: string;
	name?: string;
	contentType?: string;
	/**
	 * What a voice message said.
	 *
	 * QQ runs its own speech recognition and hands the text over, so a voice
	 * message can be acted on without this app doing any audio work at all.
	 */
	transcript?: string;
}

export interface QqMessage {
	chat: QqChat;
	/** Who spoke — a QQ number on OneBot, a user openid on the official platform. */
	senderId: string;
	senderName: string;
	text: string;
	/**
	 * The message was addressed to the bot: any private message, or a group
	 * message that mentioned it. A group message that is merely nearby is not
	 * something to answer.
	 */
	addressed: boolean;
	/**
	 * Handed back when replying, where the platform requires it. The official
	 * platform only accepts a free (unsolicited) message in limited quantity, and
	 * charges a reply against the message it answers instead.
	 */
	replyToken?: string;
	attachments?: QqAttachment[];
	/**
	 * The message this one quoted.
	 *
	 * Worth carrying because a group is not a transcript: "这个改一下" three
	 * messages after the thing it refers to is unreadable without the quote, and
	 * the model gets the same half of the conversation the human did.
	 */
	quote?: { text: string; attachments?: QqAttachment[] };
}

/** A button offered under a reply. `data` comes back verbatim when clicked. */
export interface QqAction {
	id: string;
	label: string;
	data: string;
}

/** A file to send out. Exactly one of `buffer`, `path` or `url`. */
export interface QqOutboundFile {
	kind: "image" | "video" | "file";
	/** Bytes held in memory — a rendered image that was never written to disk. */
	buffer?: Buffer;
	path?: string;
	url?: string;
	name?: string;
}

/** What the bot sends back. Text is the floor; the rest is best-effort. */
export interface QqReply {
	text: string;
	/** Dropped where the transport has no buttons rather than failing the send. */
	actions?: QqAction[];
	files?: QqOutboundFile[];
}

/** Someone pressed a button. */
export interface QqInteraction {
	chat: QqChat;
	senderId: string;
	/** The `id` of the `QqAction` that was offered. */
	actionId: string;
	data: string;
	/** Acknowledged back to the platform so the button stops spinning. */
	interactionId: string;
}

/**
 * Incremental output into one message.
 *
 * A coding task takes minutes, and the alternative is a chat that goes quiet
 * after "已创建任务" and then dumps a wall of text — which reads as a bot that
 * crashed and came back.
 */
export interface QqStream {
	update(text: string): Promise<void>;
	complete(text: string): Promise<void>;
	cancel(): void;
}

/** What a transport can actually do, so the service can degrade rather than fail. */
export interface QqCapabilities {
	stream: boolean;
	buttons: boolean;
	files: boolean;
	/** Messages render Markdown. False everywhere unless the bot was granted it. */
	markdown: boolean;
}

export type QqConnectionState = "connecting" | "ready" | "error";

export interface QqConnectionHooks {
	onMessage(message: QqMessage): void;
	/** `error` is written for the settings panel, so it says what to fix. */
	onState(state: QqConnectionState, error?: string): void;
	onInteraction(interaction: QqInteraction): void;
	/**
	 * A protocol breadcrumb for the activity log — what arrived, and what was
	 * skipped on the way to not becoming a message.
	 *
	 * Without these the panel can only report the two ends: connected, and a
	 * message acted on. Everything that goes wrong on a QQ bot happens in
	 * between — an event kind nobody handles, a gateway asking to redial, a
	 * mention that never arrived — and shows up as a bot that says nothing.
	 */
	onTrace(text: string): void;
}

export interface QqConnection {
	/** The logged-in bot's own identity, once the connection learns it. */
	readonly self: string | undefined;
	readonly capabilities: QqCapabilities;
	send(chat: QqChat, reply: QqReply, replyToken?: string): Promise<void>;
	/** Null when this transport cannot stream, which is every transport but one. */
	openStream(chat: QqChat, replyToken?: string): QqStream | null;
	close(): void;
}

/** Identifies a conversation across reconnects — the key a session binds to. */
export function chatKey(chat: QqChat): string {
	return `${chat.kind}:${chat.id}`;
}

/**
 * Back off between redials: 1s, 2s, 4s … capped at half a minute.
 *
 * Capped rather than given up on, because the usual reason a OneBot socket
 * refuses is that its backend has not finished starting, and the user is not
 * going to come back to the settings panel to press a button for that.
 */
export function retryDelay(attempt: number): number {
	return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

/**
 * A QQ message is not a transcript. Long agent answers are cut rather than
 * refused by the platform's own limit, and a marker is more honest than a
 * sentence that stops mid-word.
 */
export function clipForChat(text: string, limit = 1800): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit - 1)}…\n（内容过长已截断，完整结果请在电脑端查看）`;
}
