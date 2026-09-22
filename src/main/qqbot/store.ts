import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_QQ_BOT_CONFIG,
	normalizeQqBotConfig,
	type QqBotConfig,
	type QqBotPeer,
} from "../../shared/qqbot";

const FILE = "qq-bot.json";
/** Enough for any real use; a cap is what keeps a leak from growing unbounded. */
const MAX_PEERS = 50;

interface QqBotFile {
	version: 1;
	config: QqBotConfig;
	peers: QqBotPeer[];
}

/**
 * Persistence for the QQ bot: its connection, and the chats that have paired.
 *
 * Written with owner-only permissions. An AppSecret or an OneBot access token is
 * a credential for an account, and the peer list is the entire access-control
 * decision for something that runs commands on this machine — neither belongs
 * in a world-readable file.
 */
export class QqBotStore {
	private readonly path: string;
	private cached: QqBotFile | null = null;

	constructor(userDataDir: string) {
		mkdirSync(userDataDir, { recursive: true });
		this.path = join(userDataDir, FILE);
	}

	private file(): QqBotFile {
		if (this.cached) return this.cached;
		this.cached = this.read();
		return this.cached;
	}

	private read(): QqBotFile {
		if (!existsSync(this.path)) return { version: 1, config: { ...DEFAULT_QQ_BOT_CONFIG }, peers: [] };
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			const source = (parsed && typeof parsed === "object" ? parsed : {}) as Partial<QqBotFile>;
			return {
				version: 1,
				// A file written before peers existed is the bare config itself.
				config: normalizeQqBotConfig(source.version === 1 ? source.config : parsed),
				peers: Array.isArray(source.peers) ? source.peers.filter(isPeer) : [],
			};
		} catch {
			// A corrupt file must not lock the user out of the panel that is the only
			// place to fix it — defaults, and the next save replaces it.
			return { version: 1, config: { ...DEFAULT_QQ_BOT_CONFIG }, peers: [] };
		}
	}

	config(): QqBotConfig {
		return this.file().config;
	}

	peers(): QqBotPeer[] {
		return this.file().peers;
	}

	saveConfig(config: QqBotConfig): QqBotConfig {
		const next = normalizeQqBotConfig(config);
		this.cached = { ...this.file(), config: next };
		this.write();
		return next;
	}

	/** Add a paired chat, replacing any earlier pairing for the same chat. */
	addPeer(peer: QqBotPeer): QqBotPeer[] {
		const file = this.file();
		const peers = file.peers.filter((entry) => !(entry.kind === peer.kind && entry.chatId === peer.chatId));
		if (peers.length >= MAX_PEERS) throw new Error("已配对的聊天过多，请先在电脑端移除一些");
		this.cached = { ...file, peers: [...peers, peer] };
		this.write();
		return this.cached.peers;
	}

	/**
	 * Change what one chat has chosen for itself — its directory, its model.
	 *
	 * An explicit `undefined` in the patch clears the key rather than being
	 * skipped, because "go back to the desktop's default" is a thing a chat asks
	 * for and has to be storable.
	 */
	updatePeer(
		id: string,
		patch: Partial<Pick<QqBotPeer, "cwd" | "modelKey" | "thinkingLevel">>,
	): QqBotPeer[] {
		const file = this.file();
		this.cached = {
			...file,
			peers: file.peers.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
		};
		this.write();
		return this.cached.peers;
	}

	removePeer(id: string): QqBotPeer[] {
		const file = this.file();
		this.cached = { ...file, peers: file.peers.filter((entry) => entry.id !== id) };
		this.write();
		return this.cached.peers;
	}

	private write(): void {
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.file(), null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, this.path);
	}
}

function isPeer(value: unknown): value is QqBotPeer {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<QqBotPeer>;
	return (
		typeof entry.id === "string" &&
		typeof entry.chatId === "string" &&
		(entry.kind === "private" || entry.kind === "group" || entry.kind === "channel")
	);
}
