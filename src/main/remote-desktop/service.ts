import { randomBytes } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import type {
	DesktopAction,
	DesktopController,
	DesktopFrame,
	DesktopKeyInput,
	DesktopPointerInput,
	DesktopState,
} from "../../shared/remote-desktop";
import { shellQuote } from "../ssh-service";
import type { SshCredentials } from "../ssh-store";
import { RfbClient, type RfbRect } from "./rfb";
import { validateDesktopResolution, type DesktopResolutionInfo } from "../../shared/remote-desktop";
import { resolutionScript } from "./resolution";

/**
 * Start x11vnc on the desktop the SSH user is logged into, reachable only
 * through our tunnel: bound to localhost, a one-time password read from stdin
 * into a file x11vnc deletes on reading, gone once we disconnect (`-once`) or
 * if we never arrive (`-timeout`). Prints NEKO_PORT=… or NEKO_ERR=… and a log tail.
 *
 * Which display: a machine can have several — the login screen, a desktop
 * someone is using, an xrdp or VNC session — and the login screen is the one
 * nobody wants. So the SSH user's own display comes first, then any other
 * user's (a session in use), and a root-owned display — usually the greeter —
 * only when there is nothing else. Printed as NEKO_DISPLAY=:n.
 *
 * The X server's own `-auth` file is used when it can be read: xrdp passes a
 * relative `.Xauthority`, which `-auth guess` does not always find.
 *
 * Written for `sh -c`, so a zsh or fish login shell does not reinterpret it;
 * it avoids doubled backslashes, which fish's single quotes would eat.
 */
export const X11VNC_LAUNCH_SCRIPT = [
	"IFS= read -r pw",
	"command -v x11vnc >/dev/null 2>&1 || { echo NEKO_ERR=missing; exit 0; }",
	"me=$(id -u)",
	"disp=",
	"best=9",
	"for s in /tmp/.X11-unix/X*; do",
	'  [ -S "$s" ] || continue',
	"  owner=$(ls -ln \"$s\" | awk '{print $3}')",
	'  if [ "$owner" = "$me" ] && [ "$me" != 0 ]; then rank=0',
	'  elif [ "$owner" != 0 ]; then rank=1',
	"  else rank=2; fi",
	'  if [ "$rank" -lt "$best" ]; then best=$rank; disp="${s##*/X}"; dispowner=$owner; fi',
	"done",
	'[ -n "$disp" ] || { echo NEKO_ERR=no-display; exit 0; }',
	'echo "NEKO_DISPLAY=:$disp"',
	// Shared memory is refused across users: root reading someone else's X server needs the slower copy.
	'shm=; [ "$dispowner" = "$me" ] || shm=-noshm',
	"auth=guess",
	// X servers only, by name in one pgrep; every process when there is no pgrep.
	'pids=$(pgrep -x "Xorg|X|Xvnc|Xtigervnc|Xvfb" 2>/dev/null) || pids=$(ls /proc | grep -E "^[0-9]+$")',
	"for n in $pids; do",
	"  d=/proc/$n",
	'  args=$(tr "\\000" "\\n" < "$d/cmdline" 2>/dev/null) || continue',
	'  first=$(printf "%s\\n" "$args" | head -n 1)',
	'  case "${first##*/}" in X|Xorg|Xvnc|Xtigervnc|Xvfb) ;; *) continue ;; esac',
	'  printf "%s\\n" "$args" | grep -qx ":$disp" || continue',
	"  a=$(printf \"%s\\n\" \"$args\" | sed -n '/^-auth$/{n;p;q;}')",
	'  [ -n "$a" ] || continue',
	'  case "$a" in /*) ;; *) a="$(readlink "$d/cwd")/$a" ;; esac',
	'  if [ -r "$a" ]; then auth=$a; break; fi',
	"done",
	"umask 077",
	'f=$(mktemp) || { echo NEKO_ERR=tmp; exit 0; }',
	`printf '%s\\n' "$pw" > "$f"`,
	"log=$(mktemp)",
	'out=$(x11vnc -display ":$disp" -auth "$auth" -localhost -autoport 5950 -passwdfile "rm:$f" -once -timeout 60 -noncache -wait 10 -defer 10 $shm -quiet -bg -o "$log" 2>&1)',
	`port=$(printf '%s\\n' "$out" | sed -n 's/.*PORT=\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)`,
	// The log is only read on failure. On success x11vnc keeps writing to it
	// unlinked, so nothing is left in /tmp either way.
	'if [ -n "$port" ]; then rm -f "$log"; echo "NEKO_PORT=$port"; else rm -f "$f"; echo NEKO_ERR=start; tail -n 12 "$log" 2>/dev/null; rm -f "$log"; printf \'%s\\n\' "$out" | tail -n 5; fi',
].join("\n");

/** What the launch script said, as a port or an error a user can act on. */
export function parseLaunchOutput(output: string, host: string): { port: number; display: string | null } | { error: string } {
	const port = /NEKO_PORT=(\d+)/.exec(output);
	if (port) return { port: Number(port[1]), display: /NEKO_DISPLAY=:(\d+)/.exec(output)?.[1] ?? null };
	const code = /NEKO_ERR=([a-z-]+)/.exec(output)?.[1];
	const detail = output.replace(/NEKO_ERR=[a-z-]+\s*/, "").trim();
	switch (code) {
		case "missing":
			return { error: `x11vnc is not installed on ${host}. Install it (e.g. \`sudo apt install x11vnc\` or \`sudo dnf install x11vnc\`), or set the port of an existing VNC server in Settings → SSH.` };
		case "no-display":
			return { error: `No graphical X session was found on ${host}. Log in to the desktop first; a Wayland-only session needs its own VNC server (set its port in Settings → SSH).` };
		default:
			return { error: `x11vnc did not start on ${host}${detail ? `:\n${detail.slice(-1500)}` : ""}` };
	}
}

export interface DesktopServiceOptions {
	/** A dedicated SSH connection to the host. */
	connect(hostId: string): Promise<{ client: Client; credentials: SshCredentials }>;
	/** To every window. */
	emit(channel: "desktop:state" | "desktop:frame" | "desktop:action", payload: unknown): void;
	/** Delay between a frame change and its broadcast; batches a burst of updates. */
	frameIntervalMs?: number;
}

interface Session {
	state: DesktopState;
	ready: Promise<void>;
	client?: Client;
	rfb?: RfbClient;
	dirty: RfbRect | null;
	timer?: ReturnType<typeof setTimeout>;
	watchers: number;
	/** The X display number x11vnc attached to; null for an existing VNC server. */
	display: string | null;
	/** Framebuffer updates received, and when the last one arrived: what "settled" is measured by. */
	updates: number;
	lastUpdateAt: number;
	/** Round trip over the tunnel, from opening it: nothing the agent does shows sooner. */
	rttMs: number;
	/** What changed on screen since the agent last looked; `unseen` until it has looked once. */
	agentChanges: RfbRect[];
	agentSeen: boolean;
}

function union(a: RfbRect | null, b: RfbRect): RfbRect {
	if (!a) return { ...b };
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Changed regions this close together are one change: a dialog repainting in strips, not two. */
const CLUSTER_GAP = 32;

/**
 * Merge rectangles that overlap or lie within `gap` of each other, largest
 * first. Unlike one bounding box, a clock ticking in a corner stays apart
 * from the dialog that opened in the middle.
 */
export function clusterRects(rects: RfbRect[], gap: number): RfbRect[] {
	let clusters = rects.map((rect) => ({ ...rect }));
	for (let merged = true; merged; ) {
		merged = false;
		outer: for (let i = 0; i < clusters.length; i++) {
			for (let j = i + 1; j < clusters.length; j++) {
				const a = clusters[i];
				const b = clusters[j];
				const near =
					a.x - gap < b.x + b.width && b.x - gap < a.x + a.width &&
					a.y - gap < b.y + b.height && b.y - gap < a.y + a.height;
				if (!near) continue;
				clusters[i] = union(a, b);
				clusters.splice(j, 1);
				merged = true;
				break outer;
			}
		}
	}
	clusters = clusters.sort((a, b) => b.width * b.height - a.width * a.height);
	return clusters;
}

function execWithInput(client: Client, command: string, input: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		client.exec(command, (error, stream) => {
			if (error) return reject(error);
			let output = "";
			const timer = setTimeout(() => {
				stream.close();
				reject(new Error("The remote command timed out"));
			}, timeoutMs);
			stream.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
			stream.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
			stream.on("close", () => {
				clearTimeout(timer);
				resolve(output);
			});
			stream.end(input);
		});
	});
}

function forward(client: Client, port: number): Promise<ClientChannel> {
	return new Promise((resolve, reject) =>
		client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => (error ? reject(error) : resolve(channel))),
	);
}

/**
 * Remote desktops over SSH: one VNC connection per saved host, shared by the
 * agent and the panel, with one of them in control at a time.
 *
 * The connection is the agent's by default — it is usually the agent that
 * opens one — and the user takes it over from the panel; while they hold it
 * the agent's actions are refused with a reason it can relay, and when they
 * hand it back the agent carries on from whatever they left on screen.
 */
export class RemoteDesktopService {
	private sessions = new Map<string, Session>();
	private resizing = new Set<string>();

	constructor(private readonly options: DesktopServiceOptions) {}

	states(): DesktopState[] {
		return [...this.sessions.values()].map((session) => ({ ...session.state }));
	}

	state(hostId: string): DesktopState | null {
		const session = this.sessions.get(hostId);
		return session ? { ...session.state } : null;
	}

	private publish(): void {
		this.options.emit("desktop:state", this.states());
	}

	/** Open (or join) the host's desktop. The first opener decides who controls it. */
	async connect(hostId: string, controller: DesktopController): Promise<DesktopState> {
		let session = this.sessions.get(hostId);
		if (session && session.state.phase === "closed") {
			this.sessions.delete(hostId);
			session = undefined;
		}
		if (!session) {
			const created: Session = {
				state: { hostId, hostName: hostId, phase: "connecting", controller, width: 0, height: 0, title: "", error: null },
				ready: Promise.resolve(),
				dirty: null,
				watchers: 0,
				display: null,
				updates: 0,
				lastUpdateAt: 0,
				rttMs: 0,
				agentChanges: [],
				agentSeen: false,
			};
			created.ready = this.open(created);
			session = created;
			this.sessions.set(hostId, created);
			this.publish();
		}
		await session.ready;
		return { ...session.state };
	}

	private async open(session: Session): Promise<void> {
		try {
			const { client, credentials } = await this.options.connect(session.state.hostId);
			if (session.state.phase === "closed") { client.end(); throw new Error("Desktop connection cancelled"); }
			session.client = client;
			session.state.hostName = credentials.name;
			client.on("close", () => this.closed(session, null));
			let port = credentials.vncPort;
			let password = credentials.vncPassword;
			if (credentials.desktopMode === "sandbox") session.display = ":1";
			if (port === null) {
				password = randomBytes(6).toString("base64url").slice(0, 8);
				const output = await execWithInput(client, `sh -c ${shellQuote(X11VNC_LAUNCH_SCRIPT)}`, `${password}\n`, 30_000);
				const launched = parseLaunchOutput(output, credentials.host);
				if ("error" in launched) throw new Error(launched.error);
				port = launched.port;
				session.display = launched.display;
			}
			const opened = Date.now();
			const channel = await forward(client, port).catch((error: Error) => {
				throw new Error(`Could not reach the VNC server on ${credentials.host}:${port} through SSH: ${error.message}`);
			});
			let firstFrame: () => void = () => {};
			const framed = new Promise<void>((resolve) => (firstFrame = resolve));
			session.rttMs = Date.now() - opened;
			session.rfb = await RfbClient.connect(channel, {
				password,
				pollMs: 50,
				onUpdate: (rects) => {
					this.changed(session, rects);
					firstFrame();
				},
				onResize: (width, height) => {
					session.state.width = width;
					session.state.height = height;
					this.publish();
				},
				onClose: (error) => this.closed(session, error),
			});
			// Until the first frame lands the framebuffer is blank: a screenshot then would show nothing.
			await Promise.race([framed, sleep(5000)]);
			session.agentChanges = [];
			session.state.phase = "connected";
			session.state.width = session.rfb.width;
			session.state.height = session.rfb.height;
			session.state.title = session.rfb.title;
			this.publish();
		} catch (error) {
			this.closed(session, error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private closed(session: Session, error: Error | null): void {
		if (session.state.phase === "closed") return;
		session.state.phase = "closed";
		session.state.error = error?.message ?? session.state.error;
		if (session.timer) clearTimeout(session.timer);
		session.rfb?.close();
		session.client?.end();
		this.publish();
	}

	disconnect(hostId: string): void {
		const session = this.sessions.get(hostId);
		if (!session) return;
		this.closed(session, null);
		this.sessions.delete(hostId);
		this.publish();
	}

	disconnectAll(): void {
		for (const hostId of [...this.sessions.keys()]) this.disconnect(hostId);
	}

	setController(hostId: string, controller: DesktopController): DesktopState {
		const session = this.sessions.get(hostId);
		if (!session) throw new Error("That remote desktop is not open");
		session.state.controller = controller;
		this.publish();
		return { ...session.state };
	}

	/** The panel is showing this host (or stopped): frames flow only to a watcher. */
	watch(hostId: string, watching: boolean): void {
		const session = this.sessions.get(hostId);
		if (!session) return;
		session.watchers = Math.max(0, session.watchers + (watching ? 1 : -1));
		if (watching) this.sendFrame(session, null);
	}

	private changed(session: Session, rects: RfbRect[]): void {
		session.updates++;
		session.lastUpdateAt = Date.now();
		session.agentChanges.push(...rects);
		// A busy screen streams small updates; keep the list short by grouping them.
		if (session.agentChanges.length > 200) session.agentChanges = clusterRects(session.agentChanges, CLUSTER_GAP);
		if (!session.watchers) return;
		for (const rect of rects) session.dirty = union(session.dirty, rect);
		session.timer ??= setTimeout(() => {
			session.timer = undefined;
			const dirty = session.dirty;
			session.dirty = null;
			if (dirty) this.sendFrame(session, dirty);
		}, this.options.frameIntervalMs ?? 50);
	}

	/** A region of the framebuffer to the panel; the whole screen when `rect` is null. */
	private sendFrame(session: Session, rect: RfbRect | null): void {
		const rfb = session.rfb;
		if (!rfb || rfb.isClosed || !rfb.width) return;
		const area = rect ?? { x: 0, y: 0, width: rfb.width, height: rfb.height };
		const data = new Uint8Array(area.width * area.height * 4);
		const stride = rfb.width * 4;
		for (let row = 0; row < area.height; row++) {
			const start = (area.y + row) * stride + area.x * 4;
			data.set(rfb.framebuffer.subarray(start, start + area.width * 4), row * area.width * 4);
		}
		const frame: DesktopFrame = {
			hostId: session.state.hostId,
			...area,
			full: rect === null,
			screenWidth: rfb.width,
			screenHeight: rfb.height,
			data,
		};
		this.options.emit("desktop:frame", frame);
	}

	private live(hostId: string): { session: Session; rfb: RfbClient } {
		const session = this.sessions.get(hostId);
		if (!session?.rfb || session.state.phase !== "connected" || session.rfb.isClosed)
			throw new Error("The remote desktop is not connected");
		return { session, rfb: session.rfb };
	}

	/** Input from the panel, honoured only while the user holds control. */
	userPointer(input: DesktopPointerInput): void {
		const { session, rfb } = this.live(input.hostId);
		if (session.state.controller !== "user") return;
		rfb.pointer(input.x, input.y, input.buttons);
	}

	userKey(input: DesktopKeyInput): void {
		const { session, rfb } = this.live(input.hostId);
		if (session.state.controller !== "user") return;
		rfb.key(input.keysym, input.down);
	}

	/**
	 * The connection for an agent action: opened if need be, and refused while
	 * the user is driving — the message is what the model reads.
	 */
	async agent(hostId: string): Promise<RfbClient> {
		const current = this.sessions.get(hostId);
		if (!current || current.state.phase === "closed") await this.connect(hostId, "agent");
		else await current.ready;
		const { session, rfb } = this.live(hostId);
		if (session.state.controller === "user")
			throw new Error(
				"The user has taken control of this remote desktop. Do not act on it until they hand control back from the panel; ask them with the question tool if you need to know when.",
			);
		return rfb;
	}

	/**
	 * Wait for the screen to settle after an action: until it has been quiet for
	 * `quietMs` after changing, or `firstMs` pass with no change at all, or
	 * `maxMs` in any case — a blinking caret or a clock must not hold it forever.
	 *
	 * With `adaptive`, both floors stretch to this connection's round trip: no
	 * change can show sooner than one after the action, and on a distant server
	 * the parts of one repaint straggle in about that far apart.
	 */
	async settle(hostId: string, options: { quietMs: number; firstMs: number; maxMs: number; adaptive?: boolean; signal?: AbortSignal }): Promise<void> {
		const session = this.sessions.get(hostId);
		if (!session) return;
		const quietMs = options.adaptive ? Math.max(options.quietMs, Math.min(1200, session.rttMs * 1.5)) : options.quietMs;
		const firstMs = options.adaptive ? Math.max(options.firstMs, Math.min(3000, session.rttMs * 2 + 300)) : options.firstMs;
		const start = Date.now();
		const before = session.updates;
		for (;;) {
			if (options.signal?.aborted) throw new Error("Cancelled");
			const now = Date.now();
			if (now - start >= options.maxMs) return;
			if (session.updates === before ? now - start >= firstMs : now - session.lastUpdateAt >= quietMs) return;
			await sleep(30);
		}
	}

	/**
	 * What changed since the agent last looked, and start counting afresh.
	 * `first` is set until it has looked once: then there is nothing to diff against.
	 */
	takeAgentChanges(hostId: string): { first: boolean; regions: RfbRect[] } {
		const session = this.sessions.get(hostId);
		if (!session) return { first: true, regions: [] };
		const result = { first: !session.agentSeen, regions: clusterRects(session.agentChanges, CLUSTER_GAP) };
		session.agentSeen = true;
		session.agentChanges = [];
		return result;
	}

	/** The X display the desktop is on, when x11vnc was started for it. */
	display(hostId: string): string | null {
		return this.sessions.get(hostId)?.display ?? null;
	}

	/** Run a command on the desktop's own SSH connection, with `input` on stdin. */
	async run(hostId: string, command: string, input: string, timeoutMs: number): Promise<string> {
		const session = this.sessions.get(hostId);
		if (!session?.client || session.state.phase !== "connected") throw new Error("The remote desktop is not connected");
		return execWithInput(session.client, command, input, timeoutMs);
	}

	/** Query the exact X display behind this connection, never guess another display. */
	async resolutionInfo(hostId: string): Promise<DesktopResolutionInfo> {
		return this.runResolution(hostId);
	}

	async setResolution(hostId: string, width: number, height: number): Promise<DesktopResolutionInfo> {
		validateDesktopResolution(width, height);
		if (this.resizing.has(hostId)) throw new Error("A resolution change is already in progress");
		this.resizing.add(hostId);
		try {
			const info = await this.runResolution(hostId, { width, height });
			// RandR success alone is insufficient: the connected VNC server must follow it.
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const state = this.state(hostId);
				if (state?.phase !== "connected") throw new Error("The desktop disconnected during the resolution change");
				if (state.width === width && state.height === height) return info;
				await sleep(50);
			}
			throw new Error("The X display changed, but VNC has not reported the requested resolution. Reconnect the desktop to refresh it.");
		} finally { this.resizing.delete(hostId); }
	}

	private async runResolution(hostId: string, size?: { width: number; height: number }): Promise<DesktopResolutionInfo> {
		const display = this.display(hostId);
		if (!display || !/^:\d+$/.test(display)) throw new Error("Resolution changes require an automatically connected SSH desktop; the display of an external VNC server is unknown");
		const output = await this.run(hostId, "python3 -", resolutionScript(display, size), 45_000);
		const line = output.split(/\r?\n/).reverse().find(line => line.startsWith("NEKO_RESOLUTION="));
		if (!line) throw new Error(`Cannot query the remote resolution. Ensure python3 and xrandr are installed. ${output.slice(-500)}`);
		const info = JSON.parse(line.slice("NEKO_RESOLUTION=".length));
		if (info.error) throw new Error(String(info.error));
		if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || !Array.isArray(info.modes)) throw new Error("Invalid resolution response");
		return info;
	}

	/** Show the panel where the agent is acting. */
	markAction(action: DesktopAction): void {
		this.options.emit("desktop:action", action);
	}
}
