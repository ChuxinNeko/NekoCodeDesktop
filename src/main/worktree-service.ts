import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
	WorktreeMergeRequest,
	WorktreeMergeResult,
	WorktreeRecord,
	WorktreeStatus,
} from "../shared/worktree";
import {
	addWorktree,
	commitAll,
	countAhead,
	countDirtyFiles,
	currentBranch,
	hasCommits,
	isClean,
	mergeBranch,
	removeWorktree,
	repoRoot,
} from "./worktree-git";

const FILE = "worktrees.json";
const DIR = "worktrees";
/** Enough to be unique in a directory listing without being a wall of hex. */
const ID_BYTES = 4;

interface RecordsFile {
	version: 1;
	worktrees: WorktreeRecord[];
}

/** What isolating a directory produced — including having decided not to. */
export interface PreparedWorkspace {
	/** Where the task should run. The original directory when not isolated. */
	cwd: string;
	worktree: Omit<WorktreeRecord, "sessionId" | "sessionFile"> | null;
	/** Why isolation was skipped, for a project where it was asked for. */
	warning?: string;
}

/**
 * Gives a task its own checkout, and takes it back afterwards.
 *
 * Records outlive the process because the directories do: a worktree left
 * behind by a crash is still on disk and still registered with git, and only a
 * persisted record can say which session it belonged to.
 */
export class WorktreeService {
	private readonly path: string;
	private readonly root: string;
	private records: WorktreeRecord[] | null = null;

	constructor(userDataDir: string) {
		mkdirSync(userDataDir, { recursive: true });
		this.path = join(userDataDir, FILE);
		this.root = join(userDataDir, DIR);
	}

	private load(): WorktreeRecord[] {
		if (this.records) return this.records;
		if (!existsSync(this.path)) {
			this.records = [];
			return this.records;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as RecordsFile;
			this.records = Array.isArray(parsed.worktrees) ? parsed.worktrees : [];
		} catch {
			// Losing the index strands directories rather than corrupting a repo;
			// refusing to start over it would be the worse trade.
			this.records = [];
		}
		return this.records;
	}

	private save(): void {
		const file: RecordsFile = { version: 1, worktrees: this.load() };
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
		renameSync(temporary, this.path);
	}

	/**
	 * Make a task its own worktree, or explain why it is running in the shared
	 * directory after all.
	 *
	 * Every reason to decline is a normal state of a real project — no git, no
	 * commits yet, a detached HEAD — so none of them is an error. The task runs
	 * either way; the caller passes the warning on so the user knows which
	 * arrangement they got.
	 */
	async prepare(cwd: string): Promise<PreparedWorkspace> {
		// Silent for a project that is simply not under git: that is a steady
		// state, and a warning on every task would be noise about nothing.
		const root = await repoRoot(cwd).catch(() => null);
		if (!root) return { cwd, worktree: null };
		if (!(await hasCommits(root))) {
			return { cwd, worktree: null, warning: "仓库还没有提交，无法创建 worktree，本次共用目录" };
		}
		const base = await currentBranch(root);
		if (!base) {
			return { cwd, worktree: null, warning: "仓库处于 detached HEAD，无法确定合并目标，本次共用目录" };
		}

		const id = randomBytes(ID_BYTES).toString("hex");
		const branch = `nekocode/task-${id}`;
		const path = join(this.root, `${basename(root)}-${id}`);
		mkdirSync(this.root, { recursive: true });
		try {
			await addWorktree({ repoRoot: root, path, branch, from: base });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { cwd, worktree: null, warning: `创建 worktree 失败，本次共用目录：${detail}` };
		}
		return { cwd: path, worktree: { path, branch, repoRoot: root, base, createdAt: Date.now() } };
	}

	/** Bind a prepared worktree to the session that was created inside it. */
	attach(sessionId: string, sessionFile: string, worktree: PreparedWorkspace["worktree"]): void {
		if (!worktree) return;
		const records = this.load();
		records.push({ ...worktree, sessionId, sessionFile });
		this.save();
	}

	/**
	 * Undo a `prepare` whose session never came to exist.
	 *
	 * Separate from `release` because there is no record yet — the worktree was
	 * made, the prompt was refused, and nothing ever pointed at it.
	 */
	async discardPrepared(worktree: NonNullable<PreparedWorkspace["worktree"]>): Promise<void> {
		try {
			await removeWorktree({
				repoRoot: worktree.repoRoot, path: worktree.path, branch: worktree.branch,
			});
		} catch {
			// Fall through to the directory removal below.
		}
		if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
	}

	forSession(sessionId: string): WorktreeRecord | null {
		return this.load().find((record) => record.sessionId === sessionId) ?? null;
	}

	/** Every task checkout, so the sidebar can mark the sessions that have one. */
	list(): WorktreeRecord[] {
		return [...this.load()];
	}

	async status(sessionId: string): Promise<WorktreeStatus | null> {
		const record = this.forSession(sessionId);
		if (!record) return null;
		if (!existsSync(record.path)) return { record, dirtyFiles: 0, ahead: 0, missing: true };
		const [dirtyFiles, ahead] = await Promise.all([
			countDirtyFiles(record.path).catch(() => 0),
			countAhead(record.repoRoot, record.base, record.branch).catch(() => 0),
		]);
		return { record, dirtyFiles, ahead, missing: false };
	}

	/**
	 * Commit whatever the task left behind and merge its branch back.
	 *
	 * Every refusal happens before the main checkout is touched. Merging into a
	 * branch the user has since moved off, or on top of their own uncommitted
	 * work, would be a surprise edit to files they are in the middle of — the
	 * branch keeps the work safely until they are ready.
	 */
	async merge(request: WorktreeMergeRequest): Promise<WorktreeMergeResult> {
		const record = this.forSession(request.sessionId);
		if (!record) return { merged: false, reason: "这个任务没有独立 worktree" };
		if (!existsSync(record.path)) return { merged: false, reason: "worktree 目录已不存在" };

		const onBranch = await currentBranch(record.repoRoot).catch(() => null);
		if (onBranch !== record.base) {
			return {
				merged: false,
				reason: `主仓库当前在 ${onBranch ?? "detached HEAD"}，任务是从 ${record.base} 分出去的。切回 ${record.base} 再合并。`,
			};
		}
		if (!(await isClean(record.repoRoot))) {
			return { merged: false, reason: "主仓库有未提交的改动，先提交或暂存后再合并。" };
		}

		const message = request.message.trim() || `NekoCode 后台任务 ${record.branch}`;
		try {
			await commitAll(record.path, message);
		} catch (error) {
			return { merged: false, reason: `提交任务改动失败：${error instanceof Error ? error.message : String(error)}` };
		}

		const commits = await countAhead(record.repoRoot, record.base, record.branch);
		if (commits === 0) return { merged: false, reason: "这个任务没有产生任何改动，无需合并。" };

		try {
			await mergeBranch(record.repoRoot, record.branch);
		} catch (error) {
			return {
				merged: false,
				reason: `合并失败，已回滚主仓库：${error instanceof Error ? error.message : String(error)}`,
			};
		}
		// The branch is in history now; keeping the checkout around would only
		// leave a second copy of files that are in the main tree.
		await this.release(record.sessionId);
		return { merged: true, commits };
	}

	/** Throw the task's checkout and branch away. The session itself is untouched. */
	async discard(sessionId: string): Promise<void> {
		await this.release(sessionId);
	}

	/** Drop a session's worktree by transcript path — what a delete knows it by. */
	async releaseByFile(sessionFile: string): Promise<void> {
		const record = this.load().find((entry) => entry.sessionFile === sessionFile);
		if (record) await this.release(record.sessionId);
	}

	/**
	 * Remove the directory, the branch, and the record.
	 *
	 * The record goes last and unconditionally: a directory git has already
	 * forgotten still needs its entry cleared, or the sidebar keeps offering a
	 * merge for a branch that is not there.
	 */
	private async release(sessionId: string): Promise<void> {
		const record = this.forSession(sessionId);
		if (!record) return;
		try {
			await removeWorktree({ repoRoot: record.repoRoot, path: record.path, branch: record.branch });
		} catch {
			// git is gone or the repo moved; the directory below is still ours.
		}
		if (existsSync(record.path)) rmSync(record.path, { recursive: true, force: true });
		this.records = this.load().filter((entry) => entry.sessionId !== sessionId);
		this.save();
	}
}
