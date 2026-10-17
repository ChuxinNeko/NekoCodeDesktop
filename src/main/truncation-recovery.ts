import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isStreamInterruptionError, HELPER_STREAM_RECOVERY_PROMPT } from "./helper-completion";

export const MAX_STREAM_RECOVERIES = 2;

/**
 * How many truncated turns get a nudge before the run is stopped.
 *
 * Successful turns reset the streak, so productive work can keep going while
 * a model that truncates on every attempt cannot retry forever at full token cost.
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
	"上一次回复达到单次输出 token 上限被截断，任务尚未完成。保留已完成的工作，继续未完成的内容；纯文本答复接着断点继续，避免重复。",
	"被截断回复中的工具调用全部没有执行；此前成功的工具操作仍然保留，不要把被截断的参数当成已保存。",
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
 * from `completeHelper`, which drives its own prompt loop. Chains onto the
 * finish and request hooks so the workflow gate and compaction keep theirs.
 */
export function attachTruncationRecovery(
	session: AgentSession,
	onStopped: (message: string) => void,
): void {
	let consecutive = 0;
	let streamRecoveries = 0;
	let runSignal: AbortSignal | undefined;
	let guidance: string | undefined;

	const previousFinish = session.agent.finishTurn;
	session.agent.finishTurn = async (turn, signal) => {
		if (signal !== runSignal) {
			runSignal = signal;
			consecutive = 0;
			streamRecoveries = 0;
		}
		guidance = undefined;
		// The previous hook always runs: the session dispatches turn_end through it.
		const decision = await previousFinish?.(turn, signal);
		if (signal?.aborted || decision?.action === "end") return decision || undefined;
		const { stopReason } = turn.message;
		if (stopReason === "error" || stopReason === "aborted") {
			if (!isStreamInterruptionError(turn.message.errorMessage)) return decision || undefined;
			if (streamRecoveries >= MAX_STREAM_RECOVERIES) {
				onStopped("模型响应流连续中断，自动恢复次数已用尽。已成功执行的操作保留，任务尚未完成，可稍后继续。");
				return { action: "end" };
			}
			streamRecoveries++;
			guidance = HELPER_STREAM_RECOVERY_PROMPT.replaceAll("本子会话", "当前会话");
			// Providers omit failed assistant messages from their next request. Carry
			// only the text tail as an unverified draft, never partial tool arguments.
			const draft = turn.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			if (draft) guidance += `\n中断前的文本草稿（不代表工具已执行）：\n${draft.slice(-8000)}`;
			return { action: "retry" };
		}
		streamRecoveries = 0;
		// Count every truncated response, including those without tool calls.
		consecutive = stopReason === "length" ? consecutive + 1 : 0;
		if (consecutive > MAX_TRUNCATION_NUDGES) {
			onStopped(TRUNCATION_STOPPED_NOTICE);
			return { action: "end" };
		}
		if (stopReason === "length") {
			guidance = TRUNCATION_GUIDANCE;
			return { action: "continue" };
		}
		return decision || undefined;
	};

	const previousPrepare = session.agent.prepareRequest;
	session.agent.prepareRequest = async (request, signal) => {
		const snapshot = await previousPrepare?.(request, signal);
		if (!guidance || signal?.aborted || signal !== runSignal) return snapshot || undefined;
		const context = snapshot?.context ?? request.context;
		const recoveryPrompt = guidance;
		guidance = undefined;
		// Inject after the session rebuilds its canonical request projection;
		// prepareNextTurn context additions are replaced by that projection.
		// A fresh array: the guidance steers this run only. It is never emitted
		// as a message, so it is neither persisted nor shown in the transcript —
		// a reopened session would otherwise carry a nudge with no turn behind it.
		return {
			...snapshot,
			context: {
				...context,
				messages: [
					...context.messages,
					{ role: "user" as const, content: recoveryPrompt, timestamp: Date.now() },
				],
			},
		};
	};
}
