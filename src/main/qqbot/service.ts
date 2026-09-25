import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import {
	modelLabel,
	type AgentDefaults,
	type AgentSnapshot,
	type ModelOption,
	type SendPromptResult,
	type SessionSummary,
	type StartBackgroundTaskResult,
	type ThinkingLevel,
} from "../../shared/agent";
import type { WorkflowAnswer, WorkflowRequest } from "../../shared/workflow";
import type { CheckpointSummary, RestoreCheckpointResult } from "../../shared/checkpoints";
import {
	readPairingCode,
	type QqBotConfig,
	type QqBotLogEntry,
	type QqBotLogLevel,
	type QqBotPairing,
	type QqBotPeer,
	type QqBotPeerStatus,
	type QqBotState,
	type QqBotStatus,
	type QqTaskOptions,
} from "../../shared/qqbot";
import { OfficialConnection } from "./official";
import { OneBotConnection } from "./onebot";
import {
	chatKey,
	clipForChat,
	type QqAction,
	type QqAttachment,
	type QqChat,
	type QqConnection,
	type QqConnectionHooks,
	type QqInteraction,
	type QqMessage,
	type QqOutboundFile,
	type QqReply,
	type QqStream,
} from "./protocol";
import { extractRenderables, type Renderable } from "./code-blocks";
import { flattenMarkdown, flattenUnsupported } from "./markdown";
import { QqBotStore } from "./store";

/** Runtime state for a paired chat — what it is currently talking to. */
interface Binding {
	chat: QqChat;
	sessionId: string | null;
	/** A prompt from this chat is running and its answer has not been sent yet. */
	pending: boolean;
	/** The message to reply to, where the platform charges sends against one. */
	replyToken?: string;
	/** Open while a run streams its progress into one message. */
	stream: QqStream | null;
	/** Last text pushed into the stream, so an unchanged snapshot costs nothing. */
	streamed: string;
	/** Workflow request already put to the chat, so it is asked once. */
	askedRequestId: string | null;
	lastActiveAt: number;
}

export interface QqBotDeps {
	userDataDir: string;
	/**
	 * Start a task in a session of its own, in `cwd` itself.
	 *
	 * Never isolated into a worktree: a QQ task edits the project the way a local
	 * one does, and checkpoints are the undo — a branch in a directory the user
	 * cannot see is not something they can review from a chat.
	 */
	startTask(cwd: string, text: string, options: QqTaskOptions): Promise<StartBackgroundTaskResult>;
	/** Points a run can be put back to — the per-session undo history. */
	checkpoints(sessionId: string): Promise<CheckpointSummary[]>;
	restoreCheckpoint(sessionId: string, id: string): Promise<RestoreCheckpointResult>;
	/** Resolve and validate a directory a chat asked to work in. */
	resolveDirectory(path: string): Promise<string>;
	/** The models this install can run, and what it would pick by default. */
	defaults(cwd: string): Promise<AgentDefaults>;
	/** Retarget a run already in progress. */
	configure(sessionId: string, options: QqTaskOptions): Promise<void>;
	/** Draw a code block or table as a picture. Electron's job, so injected. */
	renderBlock(block: Renderable): Promise<Buffer>;
	/** Continue a session the bot already started. */
	sendTo(sessionId: string, text: string): Promise<SendPromptResult>;
	snapshot(sessionId: string): Promise<AgentSnapshot | null>;
	abort(sessionId: string): Promise<void>;
	/** Answer a workflow question the run is blocked on. */
	answerWorkflow(sessionId: string, answer: WorkflowAnswer): Promise<void>;
	/** The settings panel is watching; state changes are pushed, not polled. */
	onChange(): void;
	/** Overridden by tests, which have no QQ to dial. */
	connect?(config: QqBotConfig, hooks: QqConnectionHooks): QqConnection;
}

function dial(config: QqBotConfig, hooks: QqConnectionHooks): QqConnection {
	return config.protocol === "official"
		? new OfficialConnection(
				{
					appId: config.appId,
					appSecret: config.appSecret,
					sandbox: config.sandbox,
					markdown: config.markdown,
				},
				hooks,
			)
		: new OneBotConnection({ url: config.url, accessToken: config.accessToken }, hooks);
}

/** Long enough to walk to another device and type it; short enough to matter. */
const PAIRING_TTL_MS = 5 * 60_000;
/** Attempts a minute, across every chat — brute force is the thing being priced. */
const PAIR_ATTEMPTS_PER_MINUTE = 10;
const MAX_LOG = 200;
/** A log line quotes what arrived; the whole message belongs in the transcript. */
const LOG_PREVIEW = 60;
/** Anything a chat can send that is worth pulling down and handing to the agent. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const UPLOAD_DIR = "qq-uploads";
/** `![alt](path)` — how a model names an image it produced. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * Drives the agent from QQ.
 *
 * A chat is a session: the first message starts a task, and every message after
 * it continues that same conversation, which is what makes QQ usable as a front
 * end rather than a fire-and-forget command line.
 *
 * Access is by pairing code, not by a list of QQ numbers kept by hand: the
 * numbers are tedious to collect, easy to mistype, and say nothing about whether
 * the person on the other end meant to be there. A chat that has not paired is
 * met with silence — a bot that says "you are not allowed" has confirmed there
 * is something here to get into.
 */
export class QqBotService {
	private readonly store: QqBotStore;
	private connection: QqConnection | null = null;
	private state: QqBotState = "disabled";
	private error: string | undefined;
	private pairing: QqBotPairing | null = null;
	private pairAttempts: number[] = [];
	private readonly bindings = new Map<string, Binding>();
	/** Reverse index, so a settled task finds the chat waiting for it. */
	private readonly sessions = new Map<string, string>();
	private logs: QqBotLogEntry[] = [];
	private logId = 0;

	constructor(private readonly deps: QqBotDeps) {
		this.store = new QqBotStore(deps.userDataDir);
	}

	/** Bring the connection in line with the stored config. */
	refresh(): void {
		this.disconnect();
		const config = this.store.config();
		if (!config.enabled) {
			this.state = "disabled";
			this.error = undefined;
			// A code nobody can redeem is worse than none: it would sit in the panel
			// counting down while the bot is not listening.
			this.pairing = null;
			this.deps.onChange();
			return;
		}
		this.state = "connecting";
		this.error = undefined;
		const hooks: QqConnectionHooks = {
			onMessage: (message) => void this.receive(message, config),
			onInteraction: (interaction) => void this.pressed(interaction),
			onState: (state, error) => {
				if (state !== this.state || error !== this.error) {
					this.log(state === "error" ? "error" : "info", error ?? stateLine(state));
				}
				this.state = state;
				this.error = error;
				this.deps.onChange();
			},
			onTrace: (text) => {
				this.log("info", text);
				this.deps.onChange();
			},
		};
		this.connection = (this.deps.connect ?? dial)(config, hooks);
		this.deps.onChange();
	}

	private disconnect(): void {
		for (const binding of this.bindings.values()) binding.stream?.cancel();
		this.connection?.close();
		this.connection = null;
	}

	snapshot(): QqBotStatus {
		const peers: QqBotPeerStatus[] = this.store.peers().map((peer) => {
			const binding = this.bindings.get(`${peer.kind}:${peer.chatId}`);
			return {
				...peer,
				sessionId: binding?.sessionId ?? null,
				busy: binding?.pending ?? false,
				lastActiveAt: binding?.lastActiveAt ?? null,
			};
		});
		return {
			config: this.store.config(),
			state: this.state,
			...(this.error ? { error: this.error } : {}),
			...(this.connection?.self ? { self: this.connection.self } : {}),
			pairing: this.pairing && this.pairing.expiresAt > Date.now() ? { ...this.pairing } : null,
			peers: peers.sort((a, b) => (b.lastActiveAt ?? b.pairedAt) - (a.lastActiveAt ?? a.pairedAt)),
			logs: [...this.logs],
		};
	}

	save(config: QqBotConfig): QqBotStatus {
		this.store.saveConfig(config);
		// Redial unconditionally: the edit may have changed the protocol or the
		// credentials, and a live connection to the old one would be a lie.
		this.refresh();
		return this.snapshot();
	}

	/**
	 * Mint a code for someone to send the bot.
	 *
	 * Refused while disconnected rather than queued: a code is only redeemable by
	 * a message the bot receives, and one minted against a dead socket would
	 * expire before it could ever be used.
	 */
	newPairing(): QqBotStatus {
		if (this.state !== "ready") throw new Error("请先连接 QQ 后再生成配对码");
		this.pairing = {
			code: randomBytes(5).toString("hex").toUpperCase(),
			expiresAt: Date.now() + PAIRING_TTL_MS,
		};
		this.log("info", "已生成配对码，5 分钟内有效");
		this.deps.onChange();
		return this.snapshot();
	}

	revoke(id: string): QqBotStatus {
		const peer = this.store.peers().find((entry) => entry.id === id);
		this.store.removePeer(id);
		if (peer) {
			this.forget(`${peer.kind}:${peer.chatId}`);
			this.log("info", `已解除配对：${peer.label}`);
		}
		this.deps.onChange();
		return this.snapshot();
	}

	clearLog(): QqBotStatus {
		this.logs = [];
		this.deps.onChange();
		return this.snapshot();
	}

	private log(level: QqBotLogLevel, text: string): void {
		this.logs = [...this.logs, { id: ++this.logId, at: Date.now(), level, text }].slice(-MAX_LOG);
	}

	private peerOf(chat: QqChat): QqBotPeer | undefined {
		return this.store.peers().find((entry) => entry.kind === chat.kind && entry.chatId === chat.id);
	}

	private binding(message: QqMessage): Binding {
		const key = chatKey(message.chat);
		const existing = this.bindings.get(key);
		if (existing) {
			existing.lastActiveAt = Date.now();
			existing.replyToken = message.replyToken;
			return existing;
		}
		const created: Binding = {
			chat: message.chat,
			sessionId: null,
			pending: false,
			replyToken: message.replyToken,
			stream: null,
			streamed: "",
			askedRequestId: null,
			lastActiveAt: Date.now(),
		};
		this.bindings.set(key, created);
		return created;
	}

	private forget(key: string): void {
		const binding = this.bindings.get(key);
		binding?.stream?.cancel();
		if (binding?.sessionId) this.sessions.delete(binding.sessionId);
		this.bindings.delete(key);
	}

	/**
	 * Get text ready to be a QQ message.
	 *
	 * Model output is Markdown, and a QQ message is plain text unless the bot was
	 * granted 原生 Markdown — so without this the user reads the asterisks and
	 * backticks instead of what they mean.
	 */
	private present(text: string): string {
		// Even a Markdown-capable transport gets a pass: QQ draws no code fences,
		// no inline code and no tables, which is most of what a coding agent writes.
		return clipForChat(
			this.connection?.capabilities.markdown ? flattenUnsupported(text) : flattenMarkdown(text),
		);
	}

	private async reply(chat: QqChat, reply: QqReply | string, replyToken?: string): Promise<void> {
		const payload: QqReply = typeof reply === "string" ? { text: reply } : reply;
		const capable = this.connection?.capabilities;
		try {
			await this.connection?.send(
				chat,
				{
					text: this.present(payload.text),
					...(capable?.buttons && payload.actions?.length ? { actions: payload.actions } : {}),
					...(capable?.files && payload.files?.length ? { files: payload.files } : {}),
				},
				replyToken,
			);
		} catch (error) {
			// A failed reply is not worth tearing the connection down for — the next
			// message redials it anyway if the socket is gone.
			this.log("error", `回复失败：${error instanceof Error ? error.message : String(error)}`);
			this.deps.onChange();
		}
	}

	private async receive(message: QqMessage, config: QqBotConfig): Promise<void> {
		if (!message.addressed) {
			this.log("info", `未 @机器人，已忽略：${label(message)} → ${preview(message.text)}`);
			this.deps.onChange();
			return;
		}
		let text = message.text.trim();
		// A bare image with no words is still a message: the file is the content.
		if (!text && !message.attachments?.length) return;

		const peer = this.peerOf(message.chat);
		if (!peer) {
			const code = readPairingCode(text);
			// Logged either way. Silence is what the *chat* gets — it is what keeps
			// the bot from confirming itself to a stranger — but the owner's own log
			// panel is the one place this can be diagnosed, and a message that
			// arrived and did nothing is exactly what has to show up there.
			this.log(code ? "info" : "warn", `未配对的${label(message)} → ${preview(text)}`);
			this.deps.onChange();
			if (code) await this.redeem(message, code);
			return;
		}

		this.log("info", `${peer.label} → ${preview(text || "(附件)")}`);
		const binding = this.binding(message);
		this.deps.onChange();

		// Split rather than just matched: `/setdir` carries a path, and a Windows
		// one has backslashes and spaces that must survive verbatim.
		const command = /^[/／]\s*(\S+)\s*([\s\S]*)$/.exec(text);
		// /goal is the agent's own command, not the bot's: it goes to the task
		// like any message, spelled the way the agent expects.
		const goal = command && /^(goal|目标)$/i.test(command[1]);
		if (goal) text = `/goal ${command[2].trim()}`.trimEnd();
		if (command && !goal) {
			await this.command(command[1].toLowerCase(), command[2].trim(), binding, peer);
			return;
		}
		if (binding.pending) {
			await this.reply(binding.chat, "⏳ 上一条还在执行中，请稍候，或发送 /stop 终止。", binding.replyToken);
			return;
		}
		if (binding.sessionId) {
			const snapshot = await this.deps.snapshot(binding.sessionId).catch(() => null);
			// The session was deleted on the desktop; starting a new one is closer to
			// what the message asked for than an error about a task nobody remembers.
			if (!snapshot) {
				this.sessions.delete(binding.sessionId);
				binding.sessionId = null;
			}
		}
		const prompt = await this.composePrompt(message, text);
		if (binding.sessionId) await this.continue(binding, prompt, peer);
		else await this.start(binding, prompt, config, peer);
		this.deps.onChange();
	}

	/**
	 * Turn a QQ message into the prompt the agent sees.
	 *
	 * Files are pulled down and named by path rather than described: the agent
	 * has tools that read files, so a path is something it can act on, where a
	 * URL behind QQ's auth is not. A quoted message is carried as context because
	 * a group is not a transcript — "这个改一下" is unreadable without it.
	 */
	private async composePrompt(message: QqMessage, text: string): Promise<string> {
		const parts: string[] = [];
		if (message.quote?.text) parts.push(`【引用的消息】\n${message.quote.text}`);

		const spoken = message.attachments?.map((file) => file.transcript).filter(Boolean) ?? [];
		// QQ transcribes voice itself, so a voice note is text this app never
		// had to decode — and reads better than "用户发来一段语音".
		parts.push(text || spoken.join("\n") || "（无文字内容）");

		const saved = await this.download([...(message.attachments ?? []), ...(message.quote?.attachments ?? [])]);
		if (saved.length) {
			parts.push(`【随消息发来的文件，已保存到本机】\n${saved.map((file) => `- ${file}`).join("\n")}`);
		}
		return parts.join("\n\n");
	}

	/** Pull attachments onto disk. A file that will not come down is skipped, not fatal. */
	private async download(attachments: QqAttachment[]): Promise<string[]> {
		if (!attachments.length) return [];
		const dir = join(this.deps.userDataDir, UPLOAD_DIR);
		mkdirSync(dir, { recursive: true });
		const saved: string[] = [];
		for (const file of attachments) {
			if (file.kind === "voice" && file.transcript) continue;
			try {
				const response = await fetch(file.url);
				if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
				const bytes = Buffer.from(await response.arrayBuffer());
				if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("文件过大");
				const path = join(dir, `${Date.now()}-${safeName(file)}`);
				await writeFile(path, bytes);
				saved.push(path);
			} catch (error) {
				this.log("warn", `附件下载失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (saved.length) this.log("info", `已保存 ${String(saved.length)} 个附件`);
		return saved;
	}

	/**
	 * Redeem a pairing code.
	 *
	 * Rate limited across every chat, because the attacker worth pricing is one
	 * spraying codes from many accounts rather than one account guessing slowly.
	 * A wrong code is answered — the sender is visibly trying to pair, and a typo
	 * that produced silence would be impossible to tell from a broken bot.
	 */
	private async redeem(message: QqMessage, code: string): Promise<void> {
		this.pairAttempts = this.pairAttempts.filter((at) => at > Date.now() - 60_000);
		if (this.pairAttempts.length >= PAIR_ATTEMPTS_PER_MINUTE) {
			this.log("warn", "配对尝试过于频繁，已拒绝");
			this.deps.onChange();
			return;
		}
		this.pairAttempts.push(Date.now());

		const pairing = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : null;
		// Length checked first: `timingSafeEqual` throws on a mismatch rather than
		// returning false, and a stored code from an older format could be short.
		const matches =
			!!pairing &&
			code.length === pairing.code.length &&
			timingSafeEqual(Buffer.from(code, "utf8"), Buffer.from(pairing.code, "utf8"));
		if (!matches) {
			this.log("warn", `配对失败：${label(message)} 提交的配对码无效或已过期`);
			this.deps.onChange();
			await this.reply(message.chat, "❌ 配对码无效或已过期，请在电脑端重新生成。", message.replyToken);
			return;
		}

		const peer: QqBotPeer = {
			id: randomUUID(),
			kind: message.chat.kind,
			chatId: message.chat.id,
			label: label(message),
			pairedAt: Date.now(),
		};
		try {
			this.store.addPeer(peer);
		} catch (error) {
			await this.reply(message.chat, `❌ ${error instanceof Error ? error.message : String(error)}`, message.replyToken);
			return;
		}
		// Single use: the code is spent whether or not anyone else was waiting for
		// it, so a code posted somewhere public cannot be redeemed twice.
		this.pairing = null;
		this.log("info", `配对成功：${peer.label}`);
		this.deps.onChange();
		await this.reply(
			message.chat,
			"✅ 配对成功！直接发送任务内容即可开始，/new 开新任务 · /stop 停止 · /status 查看状态。",
			message.replyToken,
		);
	}

	private async command(
		command: string,
		argument: string,
		binding: Binding,
		peer: QqBotPeer,
	): Promise<void> {
		if (command === "new" || command === "新建") {
			this.release(binding);
			this.log("info", `${peer.label} 开始了新的对话`);
			await this.reply(binding.chat, "🆕 已开始新的对话，直接发送任务内容即可。", binding.replyToken);
			this.deps.onChange();
			return;
		}
		if (command === "stop" || command === "停止") {
			await this.stop(binding);
			return;
		}
		if (command === "setdir" || command === "目录") {
			await this.setDirectory(binding, peer, argument);
			return;
		}
		if (command === "model" || command === "模型") {
			await this.setModel(binding, peer, argument);
			return;
		}
		if (command === "think" || command === "思考") {
			await this.setThinking(binding, peer, argument);
			return;
		}
		if (command === "undo" || command === "撤销" || command === "回退") {
			await this.undo(binding);
			return;
		}
		if (command === "status" || command === "状态") {
			if (!binding.sessionId) {
				await this.reply(binding.chat, "还没有任务。发送任务内容即可开始。", binding.replyToken);
				return;
			}
			const snapshot = await this.deps.snapshot(binding.sessionId).catch(() => null);
			await this.reply(
				binding.chat,
				snapshot
					? `任务「${snapshot.session.title}」${snapshot.streaming ? "执行中…" : "已结束。"}`
					: "这个任务已经在电脑端被删除了，发送新的内容会开始一个新任务。",
				binding.replyToken,
			);
			return;
		}
		await this.reply(
			binding.chat,
			[
				"可用指令：",
				"/new 开始新任务 · /stop 停止 · /status 查看状态",
				"/undo 撤销上一轮文件改动",
				"/model 查看或切换模型 · /think 设置思考强度",
				"/setdir 绝对路径 设置工作目录",
				"/goal 目标 让 agent 持续工作直到完成（/goal pause|resume|stop）",
			].join("\n"),
			binding.replyToken,
		);
	}

	/**
	 * Point this chat's tasks at a directory.
	 *
	 * With no argument it reports the current one, because "where am I working"
	 * is asked far more often than it is changed, and a command that can only set
	 * makes people set it just to find out.
	 */
	private async setDirectory(binding: Binding, peer: QqBotPeer, argument: string): Promise<void> {
		const current = peer.cwd ?? this.store.config().projectPath;
		if (!argument) {
			await this.reply(
				binding.chat,
				current
					? `📁 当前工作目录：${current}${peer.cwd ? "（本聊天单独设置）" : "（电脑端设置的默认项目）"}\n发送 /setdir 绝对路径 可以更换，/setdir default 恢复默认。`
					: "还没有工作目录。发送 /setdir 绝对路径 设置一个。",
				binding.replyToken,
			);
			return;
		}
		if (argument.toLowerCase() === "default" || argument === "默认") {
			this.store.updatePeer(peer.id, { cwd: undefined });
			this.log("info", `${peer.label} 恢复了默认工作目录`);
			this.deps.onChange();
			await this.reply(
				binding.chat,
				`📁 已恢复默认工作目录：${this.store.config().projectPath || "（电脑端尚未设置）"}`,
				binding.replyToken,
			);
			return;
		}
		let resolved: string;
		try {
			resolved = await this.deps.resolveDirectory(argument);
		} catch (error) {
			await this.reply(
				binding.chat,
				`❌ ${error instanceof Error ? error.message : String(error)}`,
				binding.replyToken,
			);
			return;
		}
		this.store.updatePeer(peer.id, { cwd: resolved });
		// The session in flight was created in the old directory and cannot move;
		// unbinding makes the next message start where the chat just asked for.
		this.release(binding);
		this.log("info", `${peer.label} 将工作目录设为 ${resolved}`);
		this.deps.onChange();
		await this.reply(
			binding.chat,
			`📁 工作目录已设为：${resolved}\n下一条消息会在这里开始一个新任务。`,
			binding.replyToken,
		);
	}

	/**
	 * Pick the model this chat's tasks run on.
	 *
	 * With no argument it lists what is available and marks the current pick,
	 * because the answer to "which models do I have" is the thing you need before
	 * you can choose, and a chat has no picker to open.
	 */
	private async setModel(binding: Binding, peer: QqBotPeer, argument: string): Promise<void> {
		const defaults = await this.deps
			.defaults(peer.cwd ?? this.store.config().projectPath)
			.catch(() => null);
		const models = defaults?.models ?? [];
		if (!models.length) {
			await this.reply(binding.chat, "⚠️ 还没有可用的模型，请先在电脑端配置。", binding.replyToken);
			return;
		}
		const current = peer.modelKey ?? defaults?.modelKey ?? null;
		if (!argument) {
			const lines = models.map(
				(model, at) => `${model.key === current ? "▶" : " "} ${String(at + 1)}. ${modelLabel(model)}`,
			);
			await this.reply(
				binding.chat,
				[`🧠 可用模型（▶ 为当前）：`, ...lines, "发送 /model 序号 或 /model 名称片段 切换。"].join("\n"),
				binding.replyToken,
			);
			return;
		}

		const matches = matchModels(models, argument);
		if (!matches.length) {
			await this.reply(binding.chat, `❌ 没有匹配「${argument}」的模型，发送 /model 查看列表。`, binding.replyToken);
			return;
		}
		if (matches.length > 1) {
			await this.reply(
				binding.chat,
				[`「${argument}」匹配到多个模型，请说得更具体：`, ...matches.map((model) => `· ${modelLabel(model)}`)].join("\n"),
				binding.replyToken,
			);
			return;
		}

		const model = matches[0];
		// Cleared rather than kept: the levels a model accepts are its own, and
		// carrying "xhigh" onto a model that only does "off" would be silently
		// clamped somewhere out of sight.
		this.store.updatePeer(peer.id, { modelKey: model.key, thinkingLevel: undefined });
		peer.modelKey = model.key;
		peer.thinkingLevel = undefined;
		// Applied to the run in flight too: someone switching model mid-conversation
		// means the next turn, not the next task.
		if (binding.sessionId) {
			await this.deps
				.configure(binding.sessionId, { modelKey: model.key })
				.catch((error: unknown) => {
					this.log("warn", `切换模型失败：${error instanceof Error ? error.message : String(error)}`);
				});
		}
		this.log("info", `${peer.label} 切换到模型 ${modelLabel(model)}`);
		this.deps.onChange();
		const levels = model.thinkingLevels ?? [];
		await this.reply(
			binding.chat,
			`🧠 已切换到 ${modelLabel(model)}。${levels.length > 1 ? `\n可用思考强度：${levels.join(" / ")}，用 /think 设置。` : ""}`,
			binding.replyToken,
		);
	}

	/** Set reasoning effort, within what the chosen model actually accepts. */
	private async setThinking(binding: Binding, peer: QqBotPeer, argument: string): Promise<void> {
		const defaults = await this.deps
			.defaults(peer.cwd ?? this.store.config().projectPath)
			.catch(() => null);
		const model = defaults?.models.find((entry) => entry.key === (peer.modelKey ?? defaults.modelKey));
		// A non-reasoning model only offers "off", and PI clamps anything else back
		// to it — so the model's own list is what can be offered, not the full set.
		const levels = model?.thinkingLevels ?? defaults?.thinkingLevels ?? [];
		const current = peer.thinkingLevel ?? defaults?.thinkingLevel;
		if (!argument) {
			await this.reply(
				binding.chat,
				levels.length
					? `🎚️ 当前思考强度：${current ?? "off"}\n可选：${levels.join(" / ")}\n发送 /think 强度 切换。`
					: "当前模型不支持调整思考强度。",
				binding.replyToken,
			);
			return;
		}
		const level = argument.toLowerCase() as ThinkingLevel;
		if (!levels.includes(level)) {
			await this.reply(
				binding.chat,
				`❌ 当前模型不支持「${argument}」。可选：${levels.join(" / ") || "（无）"}`,
				binding.replyToken,
			);
			return;
		}
		this.store.updatePeer(peer.id, { thinkingLevel: level });
		peer.thinkingLevel = level;
		if (binding.sessionId) {
			await this.deps.configure(binding.sessionId, { thinkingLevel: level }).catch((error: unknown) => {
				this.log("warn", `切换思考强度失败：${error instanceof Error ? error.message : String(error)}`);
			});
		}
		this.log("info", `${peer.label} 将思考强度设为 ${level}`);
		this.deps.onChange();
		await this.reply(binding.chat, `🎚️ 思考强度已设为 ${level}。`, binding.replyToken);
	}

	/**
	 * Put the project back to before the last turn.
	 *
	 * The chat-side equivalent of the desktop's rewind, and the reason QQ tasks
	 * need no worktree: the undo is the checkpoint, taken in the project itself,
	 * rather than a branch somewhere the user cannot look at.
	 */
	private async undo(binding: Binding): Promise<void> {
		const sessionId = binding.sessionId;
		if (!sessionId) {
			await this.reply(binding.chat, "还没有任务可以撤销。", binding.replyToken);
			return;
		}
		const checkpoints = await this.deps.checkpoints(sessionId).catch(() => []);
		const latest = checkpoints.find((checkpoint) => checkpoint.codeRestorable);
		if (!latest) {
			await this.reply(binding.chat, "这个任务没有可撤销的文件改动。", binding.replyToken);
			return;
		}
		let result: RestoreCheckpointResult;
		try {
			result = await this.deps.restoreCheckpoint(sessionId, latest.id);
		} catch (error) {
			await this.reply(
				binding.chat,
				`❌ 撤销失败：${error instanceof Error ? error.message : String(error)}`,
				binding.replyToken,
			);
			return;
		}
		this.log("info", `撤销任务 #${sessionId.slice(0, 6)}：还原 ${String(result.restored)} 个文件`);
		this.deps.onChange();
		const warnings = result.warnings.length ? `\n⚠️ ${result.warnings.join("；")}` : "";
		await this.reply(
			binding.chat,
			`↩️ 已撤销「${latest.label}」这一轮：还原 ${String(result.restored)} 个文件，删除 ${String(result.deleted)} 个。${warnings}`,
			binding.replyToken,
		);
	}

	private async stop(binding: Binding): Promise<void> {
		if (!binding.sessionId) {
			await this.reply(binding.chat, "当前没有正在执行的任务。", binding.replyToken);
			return;
		}
		const id = binding.sessionId;
		await this.deps.abort(id).catch(() => undefined);
		binding.stream?.cancel();
		binding.stream = null;
		binding.pending = false;
		this.log("info", `已停止任务 #${id.slice(0, 6)}`);
		await this.reply(binding.chat, "⏹️ 已请求停止当前任务。", binding.replyToken);
		this.deps.onChange();
	}

	/** Unbind the chat from its session without touching the session itself. */
	private release(binding: Binding): void {
		binding.stream?.cancel();
		binding.stream = null;
		binding.streamed = "";
		binding.askedRequestId = null;
		if (binding.sessionId) this.sessions.delete(binding.sessionId);
		binding.sessionId = null;
		binding.pending = false;
	}

	private async start(binding: Binding, prompt: string, config: QqBotConfig, peer: QqBotPeer): Promise<void> {
		const cwd = peer.cwd ?? config.projectPath;
		if (!cwd) {
			this.log("warn", "尚未选择项目，已拒绝创建任务");
			await this.reply(
				binding.chat,
				"⚠️ 还没有工作目录。请在「设置 → 连接 → 连接至 QQ BOT」中选择项目，或发送 /setdir 绝对路径 指定一个。",
				binding.replyToken,
			);
			return;
		}
		const result = await this.deps
			.startTask(cwd, prompt, { modelKey: peer.modelKey, thinkingLevel: peer.thinkingLevel })
			.catch((error: unknown) => ({
				accepted: false as const,
				error: error instanceof Error ? error.message : String(error),
			}));
		if (!result.accepted) {
			this.log("error", `任务创建失败：${result.error}`);
			this.deps.onChange();
			await this.reply(binding.chat, `❌ 任务创建失败：${result.error}`, binding.replyToken);
			return;
		}
		binding.sessionId = result.session.id;
		binding.pending = true;
		binding.askedRequestId = null;
		this.sessions.set(result.session.id, chatKey(binding.chat));
		this.log("info", `已为 ${peer.label} 创建任务 #${result.session.id.slice(0, 6)}`);
		await this.announce(
			binding,
			`✅ 已创建任务 #${result.session.id.slice(0, 6)}（${basename(cwd)}）${result.warning ? `\n⚠️ ${result.warning}` : ""}`,
		);
		// A task can finish before this line: `startTask` resolves once the prompt
		// is accepted, not once it is answered, so the settle may already have
		// arrived and found nothing bound to deliver to.
		await this.deliver(result.session.id);
	}

	private async continue(binding: Binding, prompt: string, peer: QqBotPeer): Promise<void> {
		const sessionId = binding.sessionId;
		if (!sessionId) return;
		const result = await this.deps.sendTo(sessionId, prompt).catch((error: unknown) => ({
			accepted: false as const,
			error: error instanceof Error ? error.message : String(error),
		}));
		if (!result.accepted) {
			this.log("error", `发送失败：${result.error}`);
			this.deps.onChange();
			await this.reply(binding.chat, `❌ 发送失败：${result.error}`, binding.replyToken);
			return;
		}
		binding.pending = true;
		binding.askedRequestId = null;
		this.log("info", `${peer.label} 继续了任务 #${sessionId.slice(0, 6)}`);
		await this.announce(binding, "📨 已收到，正在处理…");
		await this.deliver(sessionId);
	}

	/**
	 * Say the run has started — as the first frame of a live message where the
	 * transport can stream, and as an ordinary reply where it cannot.
	 *
	 * Streaming is worth the branch: a coding task takes minutes, and the
	 * alternative is a chat that goes quiet after the acknowledgement and then
	 * drops a wall of text, which reads as a bot that crashed and came back.
	 */
	private async announce(binding: Binding, text: string): Promise<void> {
		binding.stream?.cancel();
		binding.streamed = "";
		const stream = this.connection?.capabilities.stream
			? (this.connection.openStream(binding.chat, binding.replyToken) ?? null)
			: null;
		binding.stream = stream;
		if (stream) {
			binding.streamed = text;
			await stream.update(text).catch((error: unknown) => {
				this.log("warn", `流式回复开启失败：${error instanceof Error ? error.message : String(error)}`);
				binding.stream = null;
			});
			if (binding.stream) return;
		}
		await this.reply(binding.chat, { text, actions: this.stopAction(binding) }, binding.replyToken);
	}

	/** One button, on the message that says a run started: the one thing to press. */
	private stopAction(binding: Binding): QqAction[] {
		if (!binding.sessionId || !this.connection?.capabilities.buttons) return [];
		return [{ id: "stop", label: "停止任务", data: `stop|${binding.sessionId}` }];
	}

	/**
	 * A run moved. Wired to every snapshot the task manager emits.
	 *
	 * Two jobs: push progress into the open stream, and put a workflow question to
	 * the chat the moment the run blocks on one — a task that stopped to ask
	 * something and had nobody to ask is a task that never finishes.
	 */
	progress(snapshot: AgentSnapshot): void {
		const key = this.sessions.get(snapshot.session.id);
		const binding = key ? this.bindings.get(key) : undefined;
		if (!binding) return;

		const request = snapshot.workflow.request;
		if (request && request.id !== binding.askedRequestId) {
			binding.askedRequestId = request.id;
			void this.ask(binding, request);
		}

		if (!binding.stream) return;
		const text = progressText(snapshot);
		// The transport throttles its own frames, but the comparison keeps this
		// from doing string work on every token of a long answer.
		if (text === binding.streamed) return;
		binding.streamed = text;
		// Compared before presenting, so the cheap check stays cheap: flattening a
		// long answer on every token of it is exactly what this guard is avoiding.
		void binding.stream.update(this.present(text)).catch(() => undefined);
	}

	/** Put a workflow question to the chat, with its options as buttons. */
	private async ask(binding: Binding, request: WorkflowRequest): Promise<void> {
		const question = request.questions[0];
		if (!question) return;
		const lines = [`❓ ${request.title}`, question.question];
		const buttons = this.connection?.capabilities.buttons;
		if (!buttons) {
			// No keyboard: the options still have to be answerable, so they are
			// numbered and the chat replies with the number.
			lines.push(
				...question.options.map((option, at) => `${String(at + 1)}. ${option.label}`),
				"回复序号即可作答。",
			);
		}
		this.log("info", `任务提问：${preview(question.question)}`);
		this.deps.onChange();
		await this.reply(
			binding.chat,
			{
				text: lines.join("\n"),
				actions: buttons
					? question.options.slice(0, 4).map((option) => ({
							id: option.id,
							label: option.label.slice(0, 20),
							data: `ans|${request.id}|${question.id}|${option.id}`,
						}))
					: [],
			},
			binding.replyToken,
		);
	}

	/** Someone pressed a button. */
	private async pressed(interaction: QqInteraction): Promise<void> {
		const binding = this.bindings.get(chatKey(interaction.chat));
		if (!binding?.sessionId) return;
		const [kind, ...rest] = interaction.data.split("|");
		if (kind === "stop") {
			await this.stop(binding);
			return;
		}
		if (kind !== "ans") return;
		const [requestId, questionId, optionId] = rest;
		this.log("info", `按钮作答：${optionId}`);
		this.deps.onChange();
		await this.deps
			.answerWorkflow(binding.sessionId, { requestId, answers: { [questionId]: { optionId } } })
			.catch((error: unknown) => {
				this.log("warn", `作答失败：${error instanceof Error ? error.message : String(error)}`);
			});
	}

	/** A task stopped running. Wired to the same signal the desktop toast uses. */
	settled(session: SessionSummary): void {
		if (!this.sessions.has(session.id)) return;
		void this.deliver(session.id);
	}

	/**
	 * Send a finished task's answer back to its chat, once.
	 *
	 * Guarded by `pending` because two things race to call it — the settle signal
	 * and the check right after a prompt is accepted — and the chat should see one
	 * answer either way.
	 */
	private async deliver(sessionId: string): Promise<void> {
		const key = this.sessions.get(sessionId);
		const binding = key ? this.bindings.get(key) : undefined;
		if (!binding?.pending) return;
		const snapshot = await this.deps.snapshot(sessionId).catch(() => null);
		if (snapshot?.streaming === true) return;
		binding.pending = false;
		binding.lastActiveAt = Date.now();
		// A session that is gone still has to release the chat: leaving `pending`
		// set would refuse every later message as "still running" forever.
		if (!snapshot) {
			this.sessions.delete(sessionId);
			binding.sessionId = null;
		}
		this.log(snapshot ? "info" : "warn", `任务 #${sessionId.slice(0, 6)} ${snapshot ? "已完成，结果已发送" : "已不存在"}`);
		this.deps.onChange();

		const answer = snapshot ? answerOf(snapshot) : "";
		const drawn = await this.pictures(answer);
		const text = snapshot
			? `✅ 任务完成\n\n${drawn.text}`
			: "⚠️ 这个任务已经在电脑端被删除了，发送新的内容会开始一个新任务。";
		// Measured against the raw answer, not the one with markers in it.
		const files = snapshot ? [...producedFiles(answer, snapshot.session.cwd), ...drawn.files] : [];

		const stream = binding.stream;
		binding.stream = null;
		binding.streamed = "";
		if (stream) {
			await stream.complete(this.present(text)).catch((error: unknown) => {
				this.log("warn", `流式收尾失败：${error instanceof Error ? error.message : String(error)}`);
			});
			// Files cannot ride a stream frame, so they follow as their own message.
			if (files.length) await this.reply(binding.chat, { text: "📎 本次的代码和文件", files }, binding.replyToken);
			return;
		}
		await this.reply(binding.chat, { text, files }, binding.replyToken);
	}

	/**
	 * Swap code blocks and tables out of the prose and into pictures.
	 *
	 * A block whose render fails goes back into the text rather than leaving its
	 * marker behind: a reply that says ［代码 1］ with no picture under it has lost
	 * the answer, which is worse than showing it unformatted.
	 */
	private async pictures(answer: string): Promise<{ text: string; files: QqOutboundFile[] }> {
		if (!answer || !this.store.config().codeImages || !this.connection?.capabilities.files) {
			return { text: answer, files: [] };
		}
		const { text, blocks } = extractRenderables(answer);
		if (!blocks.length) return { text: answer, files: [] };

		let prose = text;
		const files: QqOutboundFile[] = [];
		for (const [at, block] of blocks.entries()) {
			try {
				files.push({
					kind: "image",
					buffer: await this.deps.renderBlock(block),
					name: `${block.kind}-${String(at + 1)}.png`,
				});
			} catch (error) {
				this.log("warn", `代码图渲染失败：${error instanceof Error ? error.message : String(error)}`);
				prose = prose.replace(block.marker, `\n${block.content}\n`);
			}
		}
		if (files.length) this.log("info", `已渲染 ${String(files.length)} 张代码/表格图`);
		return { text: prose, files };
	}

	close(): void {
		this.disconnect();
		this.bindings.clear();
		this.sessions.clear();
		this.pairing = null;
		this.state = "disabled";
	}
}

/**
 * Find the model a chat asked for.
 *
 * A number picks off the printed list, which is what someone does right after
 * reading it. Otherwise it is a substring, because nobody is going to retype
 * `nekocode-3f2a…/zai-org/glm-4.6` into QQ — "glm" is what they will send. An
 * exact key or id wins outright so a precise answer is never called ambiguous.
 */
function matchModels(models: ModelOption[], query: string): ModelOption[] {
	const index = Number(query);
	if (Number.isInteger(index) && index >= 1 && index <= models.length) return [models[index - 1]];
	const needle = query.trim().toLowerCase();
	const exact = models.filter(
		(model) => model.key.toLowerCase() === needle || model.id.toLowerCase() === needle,
	);
	if (exact.length) return exact;
	return models.filter((model) =>
		[model.key, model.id, model.name, modelLabel(model)].some((field) =>
			field.toLowerCase().includes(needle),
		),
	);
}

/** What a chat is called in the log and the paired list. */
function label(message: QqMessage): string {
	if (message.chat.kind === "private") return `私聊 ${message.senderName || message.senderId}`;
	return `${message.chat.kind === "group" ? "群" : "频道"} ${message.chat.id}`;
}

function preview(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > LOG_PREVIEW ? `${line.slice(0, LOG_PREVIEW - 1)}…` : line;
}

function stateLine(state: QqBotState): string {
	if (state === "ready") return "已连接到 QQ";
	if (state === "connecting") return "正在连接 QQ…";
	return "连接已断开";
}

/** A downloaded file keeps its name, minus anything that could escape the folder. */
function safeName(file: QqAttachment): string {
	const raw = file.name?.trim() || basename(new URL(file.url).pathname) || "file";
	const cleaned = raw.replace(/[^\w.\-一-龥]/g, "_").slice(-80);
	return cleaned || `file-${file.kind}`;
}

/** What the chat sees while a run is still going. */
function progressText(snapshot: AgentSnapshot): string {
	const parts: string[] = [];
	for (let at = snapshot.cells.length - 1; at >= 0; at--) {
		const cell = snapshot.cells[at];
		if (cell.type === "assistant" && cell.text.trim()) {
			parts.push(cell.text.trim());
			break;
		}
	}
	for (let at = snapshot.cells.length - 1; at >= 0; at--) {
		const cell = snapshot.cells[at];
		if (cell.type === "tool" && (cell.status === "running" || cell.status === "pending")) {
			parts.push(`▸ ${cell.toolName}…`);
			break;
		}
	}
	return parts.join("\n\n") || "正在处理…";
}

/**
 * Images the answer points at, so they arrive as pictures rather than paths.
 *
 * Only files that exist and sit inside the session's working directory: a model
 * writing `![](/etc/passwd)` must not turn into an upload, and a path to
 * something that was never written is a broken link either way.
 */
function producedFiles(answer: string, cwd: string): QqOutboundFile[] {
	const root = resolve(cwd);
	const files: QqOutboundFile[] = [];
	for (const match of answer.matchAll(MARKDOWN_IMAGE)) {
		const raw = match[1];
		if (/^https?:/i.test(raw)) continue;
		const path = resolve(isAbsolute(raw) ? raw : join(root, raw));
		if (path !== root && !path.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) continue;
		if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
		if (!existsSync(path)) continue;
		if (!files.some((file) => file.path === path)) files.push({ kind: "image", path, name: basename(path) });
		if (files.length >= 4) break;
	}
	return files;
}

/**
 * What to send back as the answer.
 *
 * The last thing the model said, which is where a coding agent puts its summary.
 * A turn that ended on a tool error said nothing, so the error is reported
 * instead — silence would read as success.
 */
function answerOf(snapshot: AgentSnapshot): string {
	for (let at = snapshot.cells.length - 1; at >= 0; at--) {
		const cell = snapshot.cells[at];
		if (cell.type === "assistant") {
			if (cell.text.trim()) return cell.text.trim();
			if (cell.error) return `执行出错：${cell.error}`;
		}
		if (cell.type === "notice" && cell.level === "error") return `执行出错：${cell.text}`;
	}
	return snapshot.error ? `执行出错：${snapshot.error}` : "任务已结束，本次没有文字输出。";
}
