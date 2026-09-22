import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSnapshot, ModelOption, SessionSummary } from "../../shared/agent";
import { DEFAULT_QQ_BOT_CONFIG, type QqBotConfig, type QqTaskOptions } from "../../shared/qqbot";
import { QqBotService } from "./service";
import type {
	QqCapabilities,
	QqChat,
	QqConnection,
	QqConnectionHooks,
	QqMessage,
	QqReply,
	QqStream,
} from "./protocol";
import type { WorkflowAnswer } from "../../shared/workflow";
import type { Renderable } from "./code-blocks";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Stands in for QQ: records what was sent, and lets a test push a message in. */
class FakeConnection implements QqConnection {
	readonly sent: Array<{ chat: QqChat; text: string; reply: QqReply }> = [];
	/** Every frame pushed into a stream, in order, across all streams. */
	readonly streamed: string[] = [];
	streamClosed = false;
	readonly self = "QQ 100";
	constructor(
		readonly hooks: QqConnectionHooks,
		readonly capabilities: QqCapabilities = { stream: false, buttons: true, files: true, markdown: false },
	) {
		hooks.onState("ready");
	}
	async send(chat: QqChat, reply: QqReply): Promise<void> {
		this.sent.push({ chat, text: reply.text, reply });
	}
	openStream(): QqStream | null {
		if (!this.capabilities.stream) return null;
		return {
			update: async (text) => {
				this.streamed.push(text);
			},
			complete: async (text) => {
				this.streamed.push(text);
				this.streamClosed = true;
			},
			cancel: () => {
				this.streamClosed = true;
			},
		};
	}
	close(): void {}
}

function session(id: string): SessionSummary {
	return {
		id,
		sessionFile: `/tmp/${id}.jsonl`,
		cwd: "/project",
		title: "任务",
		titlePending: false,
		preview: "",
		createdAt: 0,
		updatedAt: 0,
		messageCount: 1,
	};
}

function snapshotOf(id: string, streaming: boolean, answer: string): AgentSnapshot {
	return {
		session: session(id),
		cells: answer
			? [{ id: "a1", type: "assistant", text: answer, thinking: "", streaming: false, timestamp: 0 }]
			: [],
		checkpoints: [],
		workflow: { request: null } as unknown as AgentSnapshot["workflow"],
		streaming,
		modelKey: null,
		models: [],
		thinkingLevel: "off",
		thinkingLevels: ["off"],
		mode: "auto",
		workMode: "agent",
		agentPhase: "execute",
	} as AgentSnapshot;
}

const PRIVATE: QqChat = { kind: "private", id: "10001" };
const GROUP: QqChat = { kind: "group", id: "55555" };

const MODELS: ModelOption[] = [
	{
		key: "anthropic/claude-opus-5",
		provider: "anthropic",
		providerName: "anthropic",
		id: "claude-opus-5",
		name: "Claude Opus 5",
		thinkingLevels: ["off", "low", "high"],
	},
	{
		key: "nekocode-3f2a/zai-org/glm-4.6",
		provider: "nekocode-3f2a",
		providerName: "zai",
		id: "zai-org/glm-4.6",
		name: "zai-org/glm-4.6",
		thinkingLevels: ["off"],
	},
	{
		key: "openai/gpt-5",
		provider: "openai",
		providerName: "openai",
		id: "gpt-5",
		name: "GPT-5",
	},
];

function setup(
	overrides: Partial<QqBotConfig> = {},
	capabilities?: QqCapabilities,
	failRender = false,
) {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-qqbot-test-"));
	dirs.push(dir);
	let connection: FakeConnection | null = null;
	const started: Array<{ cwd: string; text: string; modelKey?: string; thinkingLevel?: string }> = [];
	const restored: Array<{ sessionId: string; id: string }> = [];
	const configured: Array<{ sessionId: string; options: QqTaskOptions }> = [];
	const rendered: Renderable[] = [];
	/** Directories `resolveDirectory` will accept; anything else is rejected. */
	const realDirs = new Set(["/project", "/other/project"]);
	const continued: Array<{ sessionId: string; text: string }> = [];
	const aborted: string[] = [];
	const answered: Array<{ sessionId: string; answer: WorkflowAnswer }> = [];
	const snapshots = new Map<string, AgentSnapshot>();
	let nextId = 0;

	const service = new QqBotService({
		userDataDir: dir,
		startTask: async (cwd, text, options) => {
			started.push({ cwd, text, ...options });
			const id = `task-${++nextId}`;
			// A snapshot seeded by the test wins: that is how a run that finished
			// before `startTask` resolved is staged.
			if (!snapshots.has(id)) snapshots.set(id, snapshotOf(id, true, ""));
			return { accepted: true, session: session(id) };
		},
		sendTo: async (sessionId, text) => {
			continued.push({ sessionId, text });
			snapshots.set(sessionId, snapshotOf(sessionId, true, ""));
			return { accepted: true };
		},
		snapshot: async (sessionId) => snapshots.get(sessionId) ?? null,
		abort: async (sessionId) => {
			aborted.push(sessionId);
		},
		answerWorkflow: async (sessionId, answer) => {
			answered.push({ sessionId, answer });
		},
		checkpoints: async (sessionId) =>
			snapshots.has(sessionId)
				? [{ id: "cp-1", label: "修一下登录页", codeRestorable: true } as never]
				: [],
		restoreCheckpoint: async (sessionId, id) => {
			restored.push({ sessionId, id });
			return { restored: 3, deleted: 1, conversationRewound: false, warnings: [] };
		},
		resolveDirectory: async (path) => {
			if (!path.startsWith("/")) throw new Error("请使用绝对路径");
			if (!realDirs.has(path)) throw new Error(`目录不存在：${path}`);
			return path;
		},
		defaults: async () => ({
			modelKey: "anthropic/claude-opus-5",
			models: MODELS,
			thinkingLevel: "off",
			thinkingLevels: ["off", "low", "high"],
			mode: "auto",
			workMode: "agent",
			agentPhase: "execute",
		}),
		configure: async (sessionId, options) => {
			configured.push({ sessionId, options });
		},
		renderBlock: async (block) => {
			rendered.push(block);
			if (failRender) throw new Error("no display");
			return Buffer.from(`png:${block.kind}`);
		},
		onChange: () => undefined,
		connect: (_config, hooks) => {
			connection = new FakeConnection(hooks, capabilities);
			return connection;
		},
	});
	service.save({ ...DEFAULT_QQ_BOT_CONFIG, enabled: true, projectPath: "/project", ...overrides });

	const receive = async (message: Partial<QqMessage> & Pick<QqMessage, "chat" | "text">) => {
		connection!.hooks.onMessage({ senderId: "10001", senderName: "阿猫", addressed: true, ...message });
		// The handler is async all the way down; let its promise chain drain.
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	/** Redeem a fresh code from `chat`, the way a real chat gets in. */
	const pair = async (chat: QqChat = PRIVATE) => {
		const code = service.newPairing().pairing!.code;
		await receive({ chat, text: code });
	};
	/** Finish a task the way the task manager's settle signal would. */
	const finish = async (id: string, answer: string) => {
		snapshots.set(id, snapshotOf(id, false, answer));
		service.settled(session(id));
		await new Promise((resolve) => setTimeout(resolve, 0));
	};

	/** Push a snapshot the way the task manager's progress signal would. */
	const progress = (snapshot: AgentSnapshot) => {
		service.progress(snapshot);
		return new Promise((resolve) => setTimeout(resolve, 0));
	};
	/** Press a button the chat was offered. */
	const press = async (data: string, chat: QqChat = PRIVATE) => {
		connection!.hooks.onInteraction({
			chat,
			senderId: "10001",
			actionId: data.split("|").at(-1) ?? "",
			data,
			interactionId: "i1",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
	};

	return {
		service,
		started,
		continued,
		aborted,
		answered,
		restored,
		configured,
		rendered,
		finish,
		pair,
		press,
		progress,
		receive,
		sent: () => connection!.sent,
		streamed: () => connection!.streamed,
		connection: () => connection!,
		snapshots,
	};
}

/** A snapshot paused on a question, which is what blocks a run until answered. */
function askingSnapshot(id: string): AgentSnapshot {
	return {
		...snapshotOf(id, true, ""),
		workflow: {
			request: {
				id: "req-1",
				kind: "question",
				title: "需要确认",
				questions: [
					{
						id: "q1",
						question: "用哪种方案？",
						options: [
							{ id: "a", label: "方案 A" },
							{ id: "b", label: "方案 B" },
						],
					},
				],
			},
			todos: [],
			tasks: [],
		},
	} as AgentSnapshot;
}

describe("QqBotService pairing", () => {
	test("a correct code pairs the chat and spends the code", () => {
		const bot = setup();
		const code = bot.service.newPairing().pairing!.code;
		expect(code).toMatch(/^[A-F0-9]{10}$/);

		return bot.receive({ chat: PRIVATE, text: code }).then(() => {
			const status = bot.service.snapshot();
			expect(status.peers).toHaveLength(1);
			expect(status.peers[0]).toMatchObject({ kind: "private", chatId: "10001", label: "私聊 阿猫" });
			// Single use: a code posted somewhere public cannot be redeemed twice.
			expect(status.pairing).toBeNull();
			expect(bot.sent()[0].text).toContain("配对成功");
		});
	});

	test("/pair CODE works as well as the bare code", async () => {
		const bot = setup();
		const code = bot.service.newPairing().pairing!.code;
		await bot.receive({ chat: GROUP, text: `/pair ${code.toLowerCase()}` });

		expect(bot.service.snapshot().peers).toHaveLength(1);
	});

	test("/配对 CODE pairs, as an @ in a group would deliver it", async () => {
		const bot = setup();
		const code = bot.service.newPairing().pairing!.code;
		await bot.receive({ chat: GROUP, text: `/配对 ${code}` });

		expect(bot.service.snapshot().peers).toHaveLength(1);
		expect(bot.sent().at(-1)!.text).toContain("配对成功");
	});

	test("a wrong code is refused and pairs nothing", async () => {
		const bot = setup();
		bot.service.newPairing();
		await bot.receive({ chat: PRIVATE, text: "DEADBEEF00" });

		expect(bot.service.snapshot().peers).toEqual([]);
		expect(bot.sent()[0].text).toContain("配对码无效");
	});

	test("an expired code pairs nothing", async () => {
		const bot = setup();
		const code = bot.service.newPairing().pairing!.code;
		// Reach in rather than wait five minutes for the TTL.
		(bot.service as unknown as { pairing: { expiresAt: number } }).pairing.expiresAt = Date.now() - 1;
		await bot.receive({ chat: PRIVATE, text: code });

		expect(bot.service.snapshot().peers).toEqual([]);
	});

	test("an unpaired chat gets silence but is still written to the log", async () => {
		const bot = setup();
		await bot.receive({ chat: PRIVATE, text: "在吗，帮我写个功能" });

		expect(bot.started).toEqual([]);
		// Not a refusal: a reply would confirm there is something here.
		expect(bot.sent()).toEqual([]);
		// The owner's own panel is the only place this is diagnosable, so silence
		// towards QQ must not mean silence towards the log.
		expect(bot.service.snapshot().logs.some((entry) => entry.text.includes("未配对"))).toBe(true);
	});

	test("a message that never mentioned the bot is logged as ignored", async () => {
		const bot = setup();
		await bot.pair(GROUP);
		await bot.receive({ chat: GROUP, text: "随便聊聊", addressed: false });

		expect(bot.service.snapshot().logs.some((entry) => entry.text.includes("未 @机器人"))).toBe(true);
	});

	test("a code cannot be redeemed before one is generated", async () => {
		const bot = setup();
		await bot.receive({ chat: PRIVATE, text: "ABCDEF0123" });

		expect(bot.service.snapshot().peers).toEqual([]);
	});

	test("brute force is rate limited", async () => {
		const bot = setup();
		bot.service.newPairing();
		for (let attempt = 0; attempt < 15; attempt++) {
			await bot.receive({ chat: PRIVATE, text: "0000000000" });
		}
		// Ten answered refusals, then nothing — the rest are dropped unanswered.
		expect(bot.sent()).toHaveLength(10);
	});

	test("unpairing stops the chat from being answered again", async () => {
		const bot = setup();
		await bot.pair();
		const peer = bot.service.snapshot().peers[0];
		bot.service.revoke(peer.id);

		await bot.receive({ chat: PRIVATE, text: "再做点事" });
		expect(bot.started).toEqual([]);
	});

	test("pairing a chat twice replaces the record rather than duplicating it", async () => {
		const bot = setup();
		await bot.pair();
		await bot.pair();

		expect(bot.service.snapshot().peers).toHaveLength(1);
	});

	test("a code is refused while the connection is down", () => {
		const bot = setup();
		bot.service.close();
		expect(() => bot.service.newPairing()).toThrow();
	});
});

describe("QqBotService routing", () => {
	test("starts a task for a paired chat and reports the answer", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "修一下登录页" });

		expect(bot.started).toEqual([{ cwd: "/project", text: "修一下登录页" }]);
		expect(bot.sent().at(-1)!.text).toContain("已创建任务");

		await bot.finish("task-1", "已改好 LoginPage.tsx");
		expect(bot.sent().at(-1)!.text).toContain("已改好 LoginPage.tsx");
	});

	test("ignores a group message that did not address the bot", async () => {
		const bot = setup();
		await bot.pair(GROUP);
		await bot.receive({ chat: GROUP, text: "今天天气不错", addressed: false });

		expect(bot.started).toEqual([]);
	});

	test("a second message continues the chat's session", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "第一个任务" });
		await bot.finish("task-1", "完成");
		await bot.receive({ chat: PRIVATE, text: "再改一下" });

		expect(bot.started).toHaveLength(1);
		expect(bot.continued).toEqual([{ sessionId: "task-1", text: "再改一下" }]);
	});

	test("/new starts a fresh session instead of continuing", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "第一个任务" });
		await bot.finish("task-1", "完成");
		await bot.receive({ chat: PRIVATE, text: "/new" });
		await bot.receive({ chat: PRIVATE, text: "第二个任务" });

		expect(bot.continued).toEqual([]);
		expect(bot.started.map((entry) => entry.text)).toEqual(["第一个任务", "第二个任务"]);
	});

	test("/stop aborts the running task", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		await bot.receive({ chat: PRIVATE, text: "/stop" });

		expect(bot.aborted).toEqual(["task-1"]);
	});

	test("a message arriving mid-run is refused rather than queued", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		await bot.receive({ chat: PRIVATE, text: "顺便再做个别的" });

		expect(bot.continued).toEqual([]);
		expect(bot.sent().at(-1)!.text).toContain("上一条还在执行中");
	});

	test("answers once when the task settles before the ack is sent", async () => {
		const bot = setup();
		await bot.pair();
		// A task that was already finished when `startTask` resolved: the settle
		// signal fired with nothing bound to deliver to.
		bot.snapshots.set("task-1", snapshotOf("task-1", false, "秒完成"));
		await bot.receive({ chat: PRIVATE, text: "很快的任务" });

		expect(bot.sent().filter((entry) => entry.text.includes("秒完成"))).toHaveLength(1);

		// The late settle signal must not produce a second copy.
		await bot.finish("task-1", "秒完成");
		expect(bot.sent().filter((entry) => entry.text.includes("秒完成"))).toHaveLength(1);
	});

	test("refuses to start a task when no project is configured", async () => {
		const bot = setup({ projectPath: "" });
		await bot.pair(GROUP);
		await bot.receive({ chat: GROUP, text: "帮我改代码" });

		expect(bot.started).toEqual([]);
		expect(bot.sent().at(-1)!.text).toContain("还没有工作目录");
	});

	test("a group is judged by the group, not by who spoke in it", async () => {
		const bot = setup();
		await bot.pair(GROUP);
		await bot.receive({ chat: GROUP, senderId: "88888", text: "@bot 来一个" });

		expect(bot.started).toHaveLength(1);
	});

	test("a task deleted on the desktop releases the chat instead of wedging it", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		bot.snapshots.delete("task-1");
		bot.service.settled(session("task-1"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(bot.sent().at(-1)!.text).toContain("已经在电脑端被删除");
		// The chat is usable again rather than stuck reporting a run nobody has.
		await bot.receive({ chat: PRIVATE, text: "那重新来一个" });
		expect(bot.started).toHaveLength(2);
	});
});

describe("QqBotService streaming", () => {
	const STREAMING: QqCapabilities = { stream: true, buttons: true, files: true, markdown: false };

	test("runs a task as one live message instead of two", async () => {
		const bot = setup({}, STREAMING);
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });

		// The acknowledgement is the stream's first frame, not a separate message.
		expect(bot.streamed()[0]).toContain("已创建任务");
		expect(bot.sent().filter((entry) => entry.text.includes("已创建任务"))).toEqual([]);

		await bot.progress({
			...snapshotOf("task-1", true, "正在查看 LoginPage.tsx"),
		});
		expect(bot.streamed().at(-1)).toContain("正在查看 LoginPage.tsx");

		await bot.finish("task-1", "已改好");
		expect(bot.streamed().at(-1)).toContain("已改好");
		expect(bot.connection().streamClosed).toBe(true);
	});

	test("an unchanged snapshot pushes no frame", async () => {
		const bot = setup({}, STREAMING);
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		const before = bot.streamed().length;

		const same = snapshotOf("task-1", true, "同样的内容");
		await bot.progress(same);
		await bot.progress(same);

		expect(bot.streamed().length).toBe(before + 1);
	});

	test("falls back to whole replies where the transport cannot stream", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });

		expect(bot.streamed()).toEqual([]);
		expect(bot.sent().at(-1)!.text).toContain("已创建任务");
	});

	test("progress for a chat nobody is bound to is ignored", async () => {
		const bot = setup({}, STREAMING);
		await bot.progress(snapshotOf("task-unknown", true, "x"));

		expect(bot.streamed()).toEqual([]);
	});
});

describe("QqBotService buttons", () => {
	test("offers a stop button on the message that starts a run", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });

		expect(bot.sent().at(-1)!.reply.actions?.[0]).toMatchObject({ id: "stop", data: "stop|task-1" });
	});

	test("pressing stop aborts the run", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		await bot.press("stop|task-1");

		expect(bot.aborted).toEqual(["task-1"]);
	});

	test("relays a workflow question with its options as buttons", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		await bot.progress(askingSnapshot("task-1"));

		const asked = bot.sent().at(-1)!;
		expect(asked.text).toContain("用哪种方案？");
		expect(asked.reply.actions).toEqual([
			{ id: "a", label: "方案 A", data: "ans|req-1|q1|a" },
			{ id: "b", label: "方案 B", data: "ans|req-1|q1|b" },
		]);
	});

	test("asks once, however many snapshots carry the same question", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		await bot.progress(askingSnapshot("task-1"));
		await bot.progress(askingSnapshot("task-1"));

		expect(bot.sent().filter((entry) => entry.text.includes("用哪种方案？"))).toHaveLength(1);
	});

	test("pressing an option answers the workflow", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		await bot.progress(askingSnapshot("task-1"));
		await bot.press("ans|req-1|q1|b");

		expect(bot.answered).toEqual([
			{ sessionId: "task-1", answer: { requestId: "req-1", answers: { q1: { optionId: "b" } } } },
		]);
	});

	test("numbers the options instead where the transport has no buttons", async () => {
		const bot = setup({}, { stream: false, buttons: false, files: false, markdown: false });
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "跑个长任务" });
		await bot.progress(askingSnapshot("task-1"));

		const asked = bot.sent().at(-1)!;
		expect(asked.text).toContain("1. 方案 A");
		expect(asked.reply.actions).toBeUndefined();
	});
});

describe("QqBotService attachments", () => {
	test("uses QQ's voice transcript as the prompt", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({
			chat: PRIVATE,
			text: "",
			attachments: [{ kind: "voice", url: "https://example.com/v.silk", transcript: "把按钮改成圆角" }],
		});

		expect(bot.started[0].text).toContain("把按钮改成圆角");
	});

	test("carries a quoted message into the prompt", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({
			chat: PRIVATE,
			text: "这个改一下",
			quote: { text: "登录页的按钮是方角的" },
		});

		// A group is not a transcript: "这个" is unreadable without what it quoted.
		expect(bot.started[0].text).toContain("登录页的按钮是方角的");
		expect(bot.started[0].text).toContain("这个改一下");
	});

	test("downloads an image and hands the agent its path", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(Buffer.from("png-bytes"), { status: 200 })) as unknown as typeof fetch;
		try {
			const bot = setup();
			await bot.pair();
			await bot.receive({
				chat: PRIVATE,
				text: "照着这张图改",
				attachments: [{ kind: "image", url: "https://example.com/a.png", name: "a.png" }],
			});
			// Drain the download, which is a round trip the send is not waiting on.
			await new Promise((resolve) => setTimeout(resolve, 10));

			// A path is something the agent's file tools can act on; a URL behind
			// QQ's auth is not.
			const prompt = bot.started[0].text;
			expect(prompt).toContain("照着这张图改");
			const saved = /- (.+a\.png)/.exec(prompt)?.[1];
			expect(saved).toBeTruthy();
			expect(readFileSync(saved!, "utf8")).toBe("png-bytes");
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("a failed download loses the file, not the message", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
		try {
			const bot = setup();
			await bot.pair();
			await bot.receive({
				chat: PRIVATE,
				text: "看看这个",
				attachments: [{ kind: "image", url: "https://example.com/gone.png" }],
			});

			expect(bot.started).toHaveLength(1);
			expect(bot.started[0].text).toContain("看看这个");
			expect(bot.service.snapshot().logs.some((entry) => entry.text.includes("附件下载失败"))).toBe(true);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("QqBotService working directory", () => {
	test("runs in the configured project, editing it directly", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "改一下登录页" });

		expect(bot.started[0].cwd).toBe("/project");
		await bot.finish("task-1", "已改好");
		// No branch, no worktree: what it says it changed is what the user opens.
		expect(bot.sent().at(-1)!.text).not.toContain("分支");
	});

	test("/setdir points this chat somewhere else", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/setdir /other/project" });
		await bot.receive({ chat: PRIVATE, text: "改一下登录页" });

		expect(bot.started[0].cwd).toBe("/other/project");
		expect(bot.service.snapshot().peers[0].cwd).toBe("/other/project");
	});

	test("/setdir is per chat, not global", async () => {
		const bot = setup();
		await bot.pair();
		await bot.pair(GROUP);
		await bot.receive({ chat: PRIVATE, text: "/setdir /other/project" });

		await bot.receive({ chat: PRIVATE, text: "私聊的活" });
		await bot.receive({ chat: GROUP, text: "群里的活" });

		expect(bot.started.map((entry) => entry.cwd)).toEqual(["/other/project", "/project"]);
	});

	test("/setdir refuses a path that is not an existing absolute directory", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/setdir ./relative" });
		expect(bot.sent().at(-1)!.text).toContain("绝对路径");

		await bot.receive({ chat: PRIVATE, text: "/setdir /nope" });
		expect(bot.sent().at(-1)!.text).toContain("目录不存在");
		expect(bot.service.snapshot().peers[0].cwd).toBeUndefined();
	});

	test("/setdir with no argument reports where it is working", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/setdir" });

		expect(bot.sent().at(-1)!.text).toContain("/project");
	});

	test("/setdir default goes back to the configured project", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/setdir /other/project" });
		await bot.receive({ chat: PRIVATE, text: "/setdir default" });
		await bot.receive({ chat: PRIVATE, text: "干活" });

		expect(bot.started[0].cwd).toBe("/project");
	});

	test("changing directory unbinds the session that was running in the old one", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "第一个任务" });
		await bot.finish("task-1", "好了");
		await bot.receive({ chat: PRIVATE, text: "/setdir /other/project" });
		await bot.receive({ chat: PRIVATE, text: "第二个任务" });

		// A session cannot move directories, so the next message starts a new one.
		expect(bot.continued).toEqual([]);
		expect(bot.started).toHaveLength(2);
	});
});

describe("QqBotService model", () => {
	test("/model lists what is available and marks the current one", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/model" });

		const listing = bot.sent().at(-1)!.text;
		expect(listing).toContain("1. anthropic/Claude Opus 5");
		expect(listing).toContain("2. zai/glm-4.6");
		expect(listing).toContain("▶ 1.");
	});

	test("/model picks by number", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/model 2" });

		expect(bot.service.snapshot().peers[0].modelKey).toBe("nekocode-3f2a/zai-org/glm-4.6");
	});

	test("/model picks by name fragment", async () => {
		const bot = setup();
		await bot.pair();
		// Nobody retypes `nekocode-3f2a/zai-org/glm-4.6` into QQ.
		await bot.receive({ chat: PRIVATE, text: "/model glm" });

		expect(bot.service.snapshot().peers[0].modelKey).toBe("nekocode-3f2a/zai-org/glm-4.6");
	});

	test("an ambiguous fragment lists the candidates instead of guessing", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/model o" });

		expect(bot.service.snapshot().peers[0].modelKey).toBeUndefined();
		expect(bot.sent().at(-1)!.text).toContain("匹配到多个模型");
	});

	test("an unknown fragment is refused", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/model llama" });

		expect(bot.sent().at(-1)!.text).toContain("没有匹配");
	});

	test("the chosen model is used for the chat's next task", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/model glm" });
		await bot.receive({ chat: PRIVATE, text: "干活" });

		expect(bot.started[0].modelKey).toBe("nekocode-3f2a/zai-org/glm-4.6");
	});

	test("switching mid-conversation retargets the run in flight", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "干活" });
		await bot.receive({ chat: PRIVATE, text: "/model glm" });

		expect(bot.configured).toEqual([
			{ sessionId: "task-1", options: { modelKey: "nekocode-3f2a/zai-org/glm-4.6" } },
		]);
	});

	test("/think only accepts levels the chosen model offers", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/think high" });
		expect(bot.service.snapshot().peers[0].thinkingLevel).toBe("high");

		// glm-4.6 is non-reasoning: "high" would be silently clamped to "off".
		await bot.receive({ chat: PRIVATE, text: "/model glm" });
		await bot.receive({ chat: PRIVATE, text: "/think high" });
		expect(bot.sent().at(-1)!.text).toContain("不支持");
	});

	test("switching model clears a thinking level the new one cannot honour", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/think high" });
		await bot.receive({ chat: PRIVATE, text: "/model glm" });

		expect(bot.service.snapshot().peers[0].thinkingLevel).toBeUndefined();
	});

	test("/model is per chat", async () => {
		const bot = setup();
		await bot.pair();
		await bot.pair(GROUP);
		await bot.receive({ chat: PRIVATE, text: "/model glm" });
		await bot.receive({ chat: PRIVATE, text: "私聊的活" });
		await bot.receive({ chat: GROUP, text: "群里的活" });

		expect(bot.started.map((entry) => entry.modelKey)).toEqual([
			"nekocode-3f2a/zai-org/glm-4.6",
			undefined,
		]);
	});
});

describe("QqBotService rendering", () => {
	const ANSWER = "当前目录 `D:/work/mihomo` 下有:\n\n- **`.tmp-recon/`** — 目录";

	test("flattens the answer's Markdown, because a QQ message is plain text", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "看看目录" });
		await bot.finish("task-1", ANSWER);

		const sent = bot.sent().at(-1)!.text;
		expect(sent).toContain("当前目录 D:/work/mihomo 下有:");
		expect(sent).toContain("· .tmp-recon/ — 目录");
		expect(sent).not.toContain("**");
		expect(sent).not.toContain("`");
	});

	test("leaves it alone for a bot granted native Markdown", async () => {
		const bot = setup({}, { stream: false, buttons: true, files: true, markdown: true });
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "看看目录" });
		await bot.finish("task-1", ANSWER);

		expect(bot.sent().at(-1)!.text).toContain("**.tmp-recon/**");
	});

	test("streamed frames are flattened too", async () => {
		const bot = setup({}, { stream: true, buttons: true, files: true, markdown: false });
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "看看目录" });
		await bot.progress(snapshotOf("task-1", true, "正在看 **LoginPage.tsx**"));

		expect(bot.streamed().at(-1)).toContain("正在看 LoginPage.tsx");
	});
});

describe("QqBotService code images", () => {
	const WITH_CODE = [
		"改好了：",
		"",
		"```ts",
		"const a = 1;",
		"const b = 2;",
		"const c = 3;",
		"const d = 4;",
		"```",
		"",
		"就这些。",
	].join("\n");

	test("sends the code as a picture and leaves a marker in the prose", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "改一下" });
		await bot.finish("task-1", WITH_CODE);

		const sent = bot.sent().at(-1)!;
		expect(sent.text).toContain("［代码 1 · ts］");
		expect(sent.text).not.toContain("const a = 1;");
		expect(sent.reply.files).toEqual([
			{ kind: "image", buffer: Buffer.from("png:code"), name: "code-1.png" },
		]);
	});

	test("puts the code back as text when the render fails", async () => {
		const bot = setup({}, undefined, true);
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "改一下" });
		await bot.finish("task-1", WITH_CODE);

		const sent = bot.sent().at(-1)!;
		// A marker with no picture under it has lost the answer.
		expect(sent.text).not.toContain("［代码 1");
		expect(sent.text).toContain("const a = 1;");
		expect(sent.reply.files ?? []).toEqual([]);
	});

	test("is skipped when turned off", async () => {
		const bot = setup({ codeImages: false });
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "改一下" });
		await bot.finish("task-1", WITH_CODE);

		expect(bot.rendered).toEqual([]);
		expect(bot.sent().at(-1)!.text).toContain("const a = 1;");
	});

	test("is skipped where the transport cannot send files", async () => {
		const bot = setup({}, { stream: false, buttons: false, files: false, markdown: false });
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "改一下" });
		await bot.finish("task-1", WITH_CODE);

		expect(bot.rendered).toEqual([]);
	});

	test("a streamed run sends its pictures as a following message", async () => {
		const bot = setup({}, { stream: true, buttons: true, files: true, markdown: false });
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "改一下" });
		await bot.finish("task-1", WITH_CODE);

		// The stream carries the prose; a frame cannot hold an attachment.
		expect(bot.streamed().at(-1)).toContain("［代码 1 · ts］");
		expect(bot.sent().at(-1)!.reply.files).toHaveLength(1);
	});
});

describe("QqBotService undo", () => {
	test("/undo restores the last turn's file changes", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "改一下登录页" });
		await bot.finish("task-1", "已改好");
		await bot.receive({ chat: PRIVATE, text: "/undo" });

		expect(bot.restored).toEqual([{ sessionId: "task-1", id: "cp-1" }]);
		expect(bot.sent().at(-1)!.text).toContain("还原 3 个文件");
	});

	test("/undo says so plainly when there is no task", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "/undo" });

		expect(bot.restored).toEqual([]);
		expect(bot.sent().at(-1)!.text).toContain("还没有任务可以撤销");
	});
});

describe("QqBotService log", () => {
	test("records pairing, the message, and the finished task", async () => {
		const bot = setup();
		await bot.pair();
		await bot.receive({ chat: PRIVATE, text: "修一下登录页" });
		await bot.finish("task-1", "好了");

		const lines = bot.service.snapshot().logs.map((entry) => entry.text);
		expect(lines.some((line) => line.includes("配对成功"))).toBe(true);
		expect(lines.some((line) => line.includes("修一下登录页"))).toBe(true);
		expect(lines.some((line) => line.includes("已完成"))).toBe(true);
	});

	test("a failed pairing is recorded as a warning", async () => {
		const bot = setup();
		bot.service.newPairing();
		await bot.receive({ chat: PRIVATE, text: "0000000000" });

		expect(bot.service.snapshot().logs.some((entry) => entry.level === "warn")).toBe(true);
	});

	test("clearing empties it", async () => {
		const bot = setup();
		await bot.pair();
		expect(bot.service.clearLog().logs).toEqual([]);
	});
});
