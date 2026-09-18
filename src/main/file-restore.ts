import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { CheckpointDiff, CheckpointFileChange, CheckpointFileDiff } from "../shared/checkpoints";
import { diffLines } from "../shared/line-diff";
import { unpackPreimage, type ReversalPlan, type ReversalStep } from "./file-journal";

/**
 * Carrying out a reversal plan, and saying what it would do first.
 *
 * Only ever touches the files the plan names — which are the files a tool call
 * said it was changing — so a restore cannot reach into a build directory, a
 * dependency tree, or anything else the agent never wrote to. That property
 * comes free here, where the older whole-workspace design had to buy it with an
 * ignore-rule engine.
 */

/** How many changed paths a preview lists before it says "and more". */
export const MAX_DIFF_PREVIEW = 200;

/** Resolve a recorded path under the workspace, refusing anything outside it. */
function insideWorkspace(cwd: string, path: string): string | null {
	if (!path || path.includes("\0")) return null;
	const root = resolve(cwd);
	const absolute = resolve(root, path);
	const suffix = relative(root, absolute);
	if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`)) return null;
	return absolute;
}

function hash(contents: Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

/** The file's contents now, or null when it is not there. */
async function currentContents(absolute: string): Promise<Buffer | null> {
	try {
		const info = await stat(absolute);
		if (!info.isFile()) return null;
		return await readFile(absolute);
	} catch {
		return null;
	}
}

/**
 * What carrying out this plan would change, against the tree as it is now.
 *
 * Computed on demand rather than stored: the same checkpoint means something
 * different a minute later, and a count worked out when the checkpoint was taken
 * would be a stale claim about the user's files.
 */
export async function previewReversal(plan: ReversalPlan, cwd: string): Promise<CheckpointDiff> {
	const changes: CheckpointFileChange[] = [];
	const counts = { overwrite: 0, recreate: 0, delete: 0 };
	let additions = 0;
	let deletions = 0;

	for (const step of plan.steps) {
		const absolute = insideWorkspace(cwd, step.path);
		if (!absolute) continue;
		const now = await currentContents(absolute);

		if (step.before === null) {
			// The agent created it; putting things back means removing it. Already
			// gone means there is nothing to do.
			if (!now) continue;
			counts.delete++;
			// Every line of a file the agent created is a line it added.
			const lines = diffLines("", now.toString("utf8"), step.path);
			additions += lines.additions;
			deletions += lines.deletions;
			if (changes.length < MAX_DIFF_PREVIEW)
				changes.push({
					path: step.path,
					action: "delete",
					bytes: 0,
					additions: lines.additions,
					deletions: 0,
					binary: lines.binary,
				});
			continue;
		}

		let restored: Buffer;
		try {
			restored = unpackPreimage(step.before);
		} catch {
			continue;
		}
		if (now && hash(now) === hash(restored)) continue;
		const action = now ? "overwrite" : "recreate";
		counts[action]++;
		const lines = diffLines(restored.toString("utf8"), now?.toString("utf8") ?? "", step.path);
		additions += lines.additions;
		deletions += lines.deletions;
		if (changes.length < MAX_DIFF_PREVIEW)
			changes.push({
				path: step.path,
				action,
				bytes: restored.length,
				additions: lines.additions,
				deletions: lines.deletions,
				binary: lines.binary,
			});
	}

	const total = counts.overwrite + counts.recreate + counts.delete;
	changes.sort((a, b) => a.path.localeCompare(b.path));
	return {
		changes,
		truncated: total > changes.length,
		total,
		additions,
		deletions,
		counts,
		unrestorable: plan.unrestorable.map((step) => step.path),
		shellRuns: plan.opaqueRuns,
	};
}

/**
 * One file's changes since the checkpoint, as a patch to read.
 *
 * From the checkpoint's contents to the file as it is now, so an addition is a
 * line the agent added — the direction the review panel reads in. Restoring
 * undoes exactly what is shown.
 */
export async function fileDiffSince(
	step: ReversalStep,
	cwd: string,
): Promise<CheckpointFileDiff> {
	const absolute = insideWorkspace(cwd, step.path);
	const now = absolute ? await currentContents(absolute) : null;
	let before = "";
	if (step.before !== null) {
		try {
			before = unpackPreimage(step.before).toString("utf8");
		} catch {
			// A corrupt record reads as an empty file, so the diff shows the whole
			// of the current one rather than nothing at all.
		}
	}
	const diff = diffLines(before, now?.toString("utf8") ?? "", step.path);
	return {
		path: step.path,
		patch: diff.patch,
		additions: diff.additions,
		deletions: diff.deletions,
		binary: diff.binary,
	};
}

export interface ReversalOutcome {
	restored: number;
	deleted: number;
	warnings: string[];
}

/** Put one file back, or take it away. */
async function applyStep(
	step: ReversalStep,
	cwd: string,
	outcome: ReversalOutcome,
): Promise<void> {
	const absolute = insideWorkspace(cwd, step.path);
	if (!absolute) {
		outcome.warnings.push(`跳过越界路径: ${step.path}`);
		return;
	}

	if (step.before === null) {
		try {
			const info = await stat(absolute).catch(() => null);
			if (!info) return;
			await rm(absolute, { force: true });
			outcome.deleted++;
			// The directory the agent made for it goes too, but only if nothing
			// else ended up in there.
			await rmdir(dirname(absolute)).catch(() => undefined);
		} catch (error) {
			outcome.warnings.push(`无法删除 ${step.path}: ${describe(error)}`);
		}
		return;
	}

	let contents: Buffer;
	try {
		contents = unpackPreimage(step.before);
	} catch (error) {
		outcome.warnings.push(`${step.path} 的历史内容已损坏: ${describe(error)}`);
		return;
	}
	const now = await currentContents(absolute);
	if (now && hash(now) === hash(contents)) return;
	try {
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, contents);
		outcome.restored++;
	} catch (error) {
		outcome.warnings.push(`无法写入 ${step.path}: ${describe(error)}`);
	}
}

/**
 * Put the files back.
 *
 * Deletions run before writes so a path that is a directory now and a file at
 * the checkpoint stops being a directory first. Anything the plan could not
 * record is reported rather than passed over, because a restore that silently
 * left half the turn in place is worse than one that says so.
 */
export async function applyReversal(plan: ReversalPlan, cwd: string): Promise<ReversalOutcome> {
	const outcome: ReversalOutcome = { restored: 0, deleted: 0, warnings: [] };

	for (const step of plan.steps) {
		if (step.before === null) await applyStep(step, cwd, outcome);
	}
	for (const step of plan.steps) {
		if (step.before !== null) await applyStep(step, cwd, outcome);
	}

	if (plan.unrestorable.length) {
		outcome.warnings.push(
			`${plan.unrestorable.length} 个文件当时未能保存改动前的内容，无法回退：${plan.unrestorable
				.slice(0, 5)
				.map((step) => step.path)
				.join("、")}`,
		);
	}
	if (plan.opaqueRuns) {
		outcome.warnings.push(
			`这段对话里有 ${plan.opaqueRuns} 次终端命令，它们对文件的改动未被记录，不会被回退`,
		);
	}
	return outcome;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
