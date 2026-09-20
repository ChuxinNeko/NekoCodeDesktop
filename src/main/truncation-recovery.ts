import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * How many truncated turns get a nudge before the run is stopped.
 *
 * The loop only reaches here because the truncated tool calls failed, which
 * keeps it going; a model that truncates on every attempt would otherwise
 * retry forever at full token cost.
 */
export const MAX_TRUNCATION_NUDGES = 2;

/**
 * What the model is told after a response was cut off mid tool call.
 *
 * PI rejects every tool call in a truncated response — salvaged JSON arguments
 * parse but carry half a file — and reports only "re-issue with complete
 * arguments", which a model tends to satisfy by sending the same oversized
 * `write` again. This says what actually has to change.
 */
export const TRUNCATION_GUIDANCE = [
	"上一次回复达到单次输出 token 上限被截断，其中的工具调用全部没有执行——文件没有任何改动，不要把被截断的参数当成已保存。",
	"直接重发同样的调用大概率会再次截断。请改变做法：",
	"- 修改已存在的文件用 edit 做局部替换，不要用 write 重写整份文件；",
	"- 确实要新建长文件时，先 write 一个较短的骨架，再用多次 edit 逐段补全；",
	"- 本次回复不要复述文件内容或长篇推理，把输出预算留给工具参数。",
	"先确认必要的文件状态，然后接着做未完成的部分，不要重新规划或重复已经成功的步骤。",
].join("\n");

export const TRUNCATION_STOPPED_NOTICE =
	`模型连续 ${MAX_TRUNCATION_NUDGES + 1} 次因单次输出上限被截断，已停止本轮以免反复重试。` +
	"被截断的工具调用都没有执行。请让它改用 edit 分步修改，或在供应商设置的高级选项里调高「单次输出上限」。";

/**
 * Recover the main session from responses truncated by the output token limit.
 *
 * Only the interactive session needs this: subagents get the same treatment
 * from `completeHelper`, which drives its own prompt loop. Chains onto both
 * hooks so the workflow gate and compaction keep theirs.
 */
export function attachTruncationRecovery(
	session: AgentSession,
	onStopped: (message: string) => void,
): void {
	let consecutive = 0;

	const previousStop = session.agent.shouldStopAfterTurn;
	session.agent.shouldStopAfterTurn = async (context, signal) => {
		// Counted here rather than in prepareNextTurn, which only runs when the
		// loop continues: a truncated turn that called no tools ends the run on
		// its own and must not leave the count standing for the next prompt.
		consecutive = context.message.stopReason === "length" ? consecutive + 1 : 0;
		if (consecutive > MAX_TRUNCATION_NUDGES) {
			onStopped(TRUNCATION_STOPPED_NOTICE);
			return true;
		}
		return (await previousStop?.(context, signal)) === true;
	};

	const previousPrepare = session.agent.prepareNextTurnWithContext;
	session.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const snapshot = await previousPrepare?.(turn, signal);
		if (turn.message.stopReason !== "length") return snapshot;
		const context = snapshot?.context ?? turn.context;
		// A fresh array: the guidance steers this run only. It is never emitted
		// as a message, so it is neither persisted nor shown in the transcript —
		// a reopened session would otherwise carry a nudge with no turn behind it.
		return {
			...snapshot,
			context: {
				...context,
				messages: [
					...context.messages,
					{ role: "user" as const, content: TRUNCATION_GUIDANCE, timestamp: Date.now() },
				],
			},
		};
	};
}
