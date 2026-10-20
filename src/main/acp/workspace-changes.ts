/**
 * What an agent's shell commands did to the project's files.
 *
 * An ACP agent reports a diff for its own file tools, but a command that
 * writes a file — Codex's `exec_command`, Claude's Bash, a formatter — is just
 * a command to the protocol. To show those changes too, the working tree is
 * snapshotted with git and compared around each command.
 *
 * A snapshot is a tree object written through an index of NekoCode's own
 * (`GIT_INDEX_FILE`), seeded from the repository's so unchanged files are not
 * hashed again. The user's index, refs and working tree are never touched; the
 * only trace is loose objects, which git collects as it does any other.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** One file as a command left it, in the line format the edit card reads. */
export interface ShellFileChange {
	path: string;
	kind: "add" | "delete" | "update";
	/** `+12 text`, `-12 text`, ` 12 text` and ` ...` between hunks — pi's edit diff format. */
	diff: string;
	/** A new file's content, for the write card. */
	content?: string;
}

/** Past this much patch text a command's changes are not shown; a generator ran, not an edit. */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** Each git call: a snapshot that cannot be taken in this long is skipped, not waited on. */
const GIT_TIMEOUT_MS = 20_000;

function run(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			// Paths verbatim (a Chinese file name stays readable), no pager or colour.
			["-c", "core.quotepath=false", "--no-pager", ...args],
			{
				cwd,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
				maxBuffer: MAX_PATCH_BYTES * 2,
				timeout: GIT_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
		);
	});
}

/** Comparing paths the way the file system does. */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
	const normalized = resolve(path).replace(/\\/g, "/");
	return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/**
 * A `git diff` patch, file by file, in the edit card's line format. Paths in
 * the patch are relative to `cwd` (`--relative`); binary files are left out,
 * there is nothing to read in them.
 */
export function parsePatch(patch: string, cwd: string): ShellFileChange[] {
	const changes: ShellFileChange[] = [];
	const sections = patch.split(/^diff --git /m).slice(1);
	for (const section of sections) {
		const lines = section.split("\n");
		let kind: ShellFileChange["kind"] = "update";
		let oldPath: string | null = null;
		let newPath: string | null = null;
		let index = 1;
		for (; index < lines.length && !lines[index].startsWith("@@"); index++) {
			const line = lines[index];
			if (line.startsWith("new file mode")) kind = "add";
			else if (line.startsWith("deleted file mode")) kind = "delete";
			else if (line.startsWith("--- ")) oldPath = line.slice(4);
			else if (line.startsWith("+++ ")) newPath = line.slice(4);
			else if (line.startsWith("Binary files")) break;
		}
		const named = kind === "delete" ? oldPath : newPath;
		if (!named || named === "/dev/null") continue;
		const relative = named.replace(/^[ab]\//, "").replace(/\t$/, "");
		const out: string[] = [];
		const added: string[] = [];
		let oldLine = 0;
		let newLine = 0;
		for (; index < lines.length; index++) {
			const line = lines[index];
			const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (hunk) {
				if (out.length > 0) out.push(" ...");
				oldLine = Number(hunk[1]);
				newLine = Number(hunk[2]);
				continue;
			}
			const text = line.slice(1).replace(/\r$/, "");
			if (line.startsWith("+")) {
				out.push(`+${newLine++} ${text}`);
				added.push(text);
			} else if (line.startsWith("-")) {
				out.push(`-${oldLine++} ${text}`);
			} else if (line.startsWith(" ")) {
				out.push(` ${oldLine++} ${text}`);
				newLine++;
			}
			// `\ No newline at end of file`, and the patch's trailing empty line.
		}
		if (out.length === 0) continue;
		changes.push({
			path: resolve(cwd, relative),
			kind,
			diff: out.join("\n"),
			...(kind === "add" ? { content: added.join("\n") } : {}),
		});
	}
	return changes;
}

export class WorkspaceSnapshots {
	/** One git operation at a time: they share the index file. */
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;

	private constructor(
		private readonly cwd: string,
		private readonly indexFile: string,
		readonly workspaceKey: string,
	) {}

	/** Null outside a git work tree, or where git cannot run. */
	static async open(cwd: string): Promise<WorkspaceSnapshots | null> {
		try {
			if ((await run(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return null;
			const root = (await run(cwd, ["rev-parse", "--show-toplevel"])).trim();
			const workspaceKey = pathKey(await realpath(root));
			const realIndex = resolve(cwd, (await run(cwd, ["rev-parse", "--git-path", "index"])).trim());
			const indexFile = join(tmpdir(), `nekocode-acp-${randomUUID()}.index`);
			// A repository without commits has no index yet; one is built from nothing.
			await copyFile(realIndex, indexFile).catch(() => undefined);
			return new WorkspaceSnapshots(cwd, indexFile, workspaceKey);
		} catch {
			return null;
		}
	}

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** The working tree under `cwd` as it is now, ignored files aside. */
	snapshot(): Promise<string> {
		return this.serial(async () => {
			if (this.disposed) throw new Error("disposed");
			const env = { GIT_INDEX_FILE: this.indexFile };
			// One file git cannot add — a `nul` on Windows, one locked by an editor —
			// must not cost the whole snapshot: the rest is added and the add still
			// fails, which is not a reason to stop.
			await run(this.cwd, ["add", "--all", "--ignore-errors", "--", "."], env).catch(() => undefined);
			return (await run(this.cwd, ["write-tree"], env)).trim();
		});
	}

	/** What changed under `cwd` between two snapshots. */
	changes(from: string, to: string): Promise<ShellFileChange[]> {
		if (from === to) return Promise.resolve([]);
		return this.serial(async () => {
			const patch = await run(this.cwd, [
				"diff-tree",
				"-r",
				"-p",
				"--no-color",
				"--no-ext-diff",
				"--no-renames",
				"--relative",
				"-U3",
				from,
				to,
			]);
			if (patch.length > MAX_PATCH_BYTES) return [];
			return parsePatch(patch, this.cwd);
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		void this.queue.then(() => rm(this.indexFile, { force: true }));
	}
}

/**
 * Within one turn, the files each command changed. The turn starts from a
 * snapshot; each command that finishes takes the next one, and owns what
 * changed in between — minus the files the agent's own edit tools reported,
 * which already have their card. Directory diffs cannot identify the writer
 * when sessions overlap in one worktree: those turns publish no inferred cards.
 */
interface TrackedTurn { ambiguous: boolean }
const activeTurns = new Map<string, Set<TrackedTurn>>();

export class ShellChangeTracker {
	private base: string | null = null;
	/** Settling one command at a time: each starts from where the last left off. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Edit tool calls this turn, by tool call: the files they report, and whether they are over. */
	private readonly edits = new Map<string, { paths: string[]; done: boolean }>();
	private turn: TrackedTurn | null = null;
	private readonly ownedTurns = new Set<TrackedTurn>();

	constructor(
		private readonly snapshots: Pick<WorkspaceSnapshots, "snapshot" | "changes" | "dispose">,
		private readonly workspaceKey?: string,
	) {}

	private release(turn: TrackedTurn): void {
		this.ownedTurns.delete(turn);
		if (!this.workspaceKey) return;
		const turns = activeTurns.get(this.workspaceKey);
		turns?.delete(turn);
		if (turns?.size === 0) activeTurns.delete(this.workspaceKey);
	}

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** A turn is starting: what is on disk now is not the agent's doing. */
	begin(): Promise<void> {
		const turn: TrackedTurn = { ambiguous: false };
		this.turn = turn;
		this.ownedTurns.add(turn);
		if (this.workspaceKey) {
			const turns = activeTurns.get(this.workspaceKey) ?? new Set<TrackedTurn>();
			if (turns.size > 0) {
				turn.ambiguous = true;
				for (const other of turns) other.ambiguous = true;
			}
			turns.add(turn);
			activeTurns.set(this.workspaceKey, turns);
		}
		this.edits.clear();
		return this.serial(async () => {
			this.base = await this.snapshots.snapshot().catch(() => null);
		});
	}

	/** The turn is over; nothing is attributed until the next one begins. */
	end(): Promise<void> {
		const turn = this.turn;
		this.turn = null;
		return this.serial(async () => {
			this.base = null;
			if (turn) this.release(turn);
		});
	}

	/** An edit tool reported changes to these files; `done` once the call has finished. */
	noteEdit(toolCallId: string, paths: string[], done: boolean): void {
		const known = this.edits.get(toolCallId);
		this.edits.set(toolCallId, { paths: paths.length > 0 ? paths : (known?.paths ?? []), done: done || !!known?.done });
	}

	/** A command finished: what it changed that no edit tool already showed. */
	settle(): Promise<ShellFileChange[]> {
		const turn = this.turn;
		return this.serial(async () => {
			const from = this.base;
			if (!from || !turn || turn.ambiguous) return [];
			const to = await this.snapshots.snapshot().catch(() => null);
			if (!to) return [];
			this.base = to;
			// Taken now, after the snapshot: an edit reported by then is in it.
			const shown = new Set<string>();
			for (const [id, edit] of this.edits) {
				for (const path of edit.paths) shown.add(pathKey(path));
				// A finished edit is accounted for from here on; one still running may land later.
				if (edit.done) this.edits.delete(id);
			}
			const changes = await this.snapshots.changes(from, to).catch(() => []);
			// A second session may have started while git was taking the snapshot.
			return turn.ambiguous ? [] : changes.filter((change) => !shown.has(pathKey(change.path)));
		});
	}

	dispose(): void {
		this.base = null;
		this.turn = null;
		for (const turn of this.ownedTurns) this.release(turn);
		this.snapshots.dispose();
	}
}

/** A tracker for a project, or null where it is not a git work tree. */
export async function openShellChanges(cwd: string): Promise<ShellChangeTracker | null> {
	const snapshots = await WorkspaceSnapshots.open(cwd);
	return snapshots ? new ShellChangeTracker(snapshots, snapshots.workspaceKey) : null;
}
