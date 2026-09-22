import type { ThinkingLevel } from "./agent";

/**
 * How the desktop reaches QQ.
 *
 * `onebot` is a bot backend the user already runs — NapCat, Lagrange, go-cqhttp
 * — spoken to over its OneBot v11 WebSocket. `official` is the QQ 机器人开放平台
 * at q.qq.com, dialled through its own gateway with an AppID and secret. They
 * are different protocols end to end, not two addresses for one thing, which is
 * why the dialog switches fields rather than just a URL.
 */
export type QqBotProtocol = "onebot" | "official";

export interface QqBotConfig {
	enabled: boolean;
	protocol: QqBotProtocol;
	/** OneBot: the WebSocket the implementation serves, e.g. `ws://127.0.0.1:3001`. */
	url: string;
	/** OneBot: the `access_token` that implementation was configured with. */
	accessToken: string;
	/** Official: AppID from q.qq.com. */
	appId: string;
	/** Official: AppSecret from q.qq.com. */
	appSecret: string;
	/** Official: dial the sandbox gateway instead of production. */
	sandbox: boolean;
	/**
	 * Send answers as Markdown instead of flattening them to plain text.
	 *
	 * Off by default, and only meaningful on the official platform. 原生 Markdown
	 * is a per-bot permission granted on q.qq.com; a bot without it has its
	 * `msg_type=2` messages rejected outright, so turning this on without the
	 * permission trades unrendered markup for no message at all.
	 */
	markdown: boolean;
	/**
	 * Send code blocks and tables as rendered images.
	 *
	 * QQ has no syntax for either, and they are the two things that lose the most
	 * when flattened — indentation collapses and columns stop lining up. Rendered
	 * locally with the Chromium already in this process, so nothing leaves the
	 * machine on its way to the chat.
	 */
	codeImages: boolean;
	/**
	 * Where a task the bot starts runs, unless the chat set its own with
	 * `/setdir`. Empty means the bot refuses to start one.
	 */
	projectPath: string;
}

export const DEFAULT_QQ_BOT_CONFIG: QqBotConfig = {
	enabled: false,
	protocol: "onebot",
	url: "ws://127.0.0.1:3001",
	accessToken: "",
	appId: "",
	appSecret: "",
	sandbox: false,
	markdown: false,
	codeImages: true,
	projectPath: "",
};

export type QqBotChatKind = "private" | "group" | "channel";

/**
 * A chat that has paired, and may drive the agent.
 *
 * A group pairs as a group rather than per member: the point of pairing one is
 * that the people in it may use the bot, and asking every member to redeem a
 * code would be the hand-maintained allowlist this replaced.
 */
export interface QqBotPeer {
	id: string;
	kind: QqBotChatKind;
	/** QQ number, group number, or the openid the official platform uses instead. */
	chatId: string;
	/** What the panel shows — the nickname or group at the time it paired. */
	label: string;
	pairedAt: number;
	/**
	 * Working directory this chat's tasks run in, set with `/setdir`.
	 *
	 * Per chat rather than one global setting, because two chats are two
	 * conversations: a group working on one project and a private chat on another
	 * is the ordinary case, and making them share a directory would have each
	 * one silently retarget the other.
	 */
	cwd?: string;
	/** Model this chat's tasks run on, set with `/model`. Falls back to the desktop's. */
	modelKey?: string;
	/** Reasoning effort, set with `/think`. Only levels the chosen model accepts. */
	thinkingLevel?: ThinkingLevel;
}

/** What a chat has chosen for the tasks it starts. */
export interface QqTaskOptions {
	modelKey?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Runtime state folded onto a peer for the settings panel. */
export interface QqBotPeerStatus extends QqBotPeer {
	/** The session this chat is currently talking to. */
	sessionId: string | null;
	/** A prompt from this chat is running. */
	busy: boolean;
	lastActiveAt: number | null;
}

/** An unredeemed pairing code. Single use, and it expires. */
export interface QqBotPairing {
	code: string;
	expiresAt: number;
}

export type QqBotLogLevel = "info" | "warn" | "error";

/**
 * One line of what the bot did.
 *
 * A QQ connection fails in places the user cannot see — a backend that is not
 * listening, a code that expired, a group whose mention never arrived — and
 * without a log the only symptom is a bot that says nothing.
 */
export interface QqBotLogEntry {
	id: number;
	at: number;
	level: QqBotLogLevel;
	text: string;
}

export type QqBotState = "disabled" | "connecting" | "ready" | "error";

export interface QqBotStatus {
	config: QqBotConfig;
	state: QqBotState;
	/** Why it is not `ready`. Written for the user, not for a log. */
	error?: string;
	/** The logged-in bot's own identity, once the connection reports it. */
	self?: string;
	pairing: QqBotPairing | null;
	peers: QqBotPeerStatus[];
	logs: QqBotLogEntry[];
}

/**
 * Read a config back through the defaults.
 *
 * The file is hand-editable and survives downgrades, so a missing or mistyped
 * key falls back instead of reaching the connection as `undefined`.
 */
export function normalizeQqBotConfig(value: unknown): QqBotConfig {
	const source = (value && typeof value === "object" ? value : {}) as Partial<QqBotConfig>;
	const text = (raw: unknown, fallback: string) => (typeof raw === "string" ? raw.trim() : fallback);
	return {
		enabled: source.enabled === true,
		protocol: source.protocol === "official" ? "official" : "onebot",
		url: text(source.url, DEFAULT_QQ_BOT_CONFIG.url),
		accessToken: text(source.accessToken, ""),
		appId: text(source.appId, ""),
		appSecret: text(source.appSecret, ""),
		sandbox: source.sandbox === true,
		markdown: source.markdown === true,
		// Defaults on, so `undefined` from an older file has to mean `true`.
		codeImages: source.codeImages !== false,
		// Not canonicalized here: the main process resolves it, and the renderer
		// only ever shows what the folder picker handed back.
		projectPath: typeof source.projectPath === "string" ? source.projectPath : "",
	};
}

/** The shape a pairing code takes in chat: ten hex characters, upper case. */
export const QQ_PAIRING_CODE = /^[A-F0-9]{10}$/;

/**
 * Pull a pairing code out of a message, or nothing if it is not one.
 *
 * Both the bare code and `/pair <code>` are accepted: a code pasted on its own
 * is what someone does without reading instructions, and the command is what
 * they do after reading them.
 *
 * No `\b` after the verb — a word boundary is defined over `[A-Za-z0-9_]`, so
 * there is none after `配对`, and anchoring on one silently dropped every
 * Chinese-language pairing attempt.
 */
export function readPairingCode(text: string): string | null {
	const body = text.replace(/^[/／]\s*(?:pair|bind|配对|绑定)\s*/i, "").trim().toUpperCase();
	return QQ_PAIRING_CODE.test(body) ? body : null;
}
