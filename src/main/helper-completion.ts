import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { FusionRequestDeadline } from "./fusion-resilience";

export interface HelperCompletionPolicy {
	maxTurns: number;
	beforeRequest?: () => string | undefined;
	timeoutMs?: number;
	reportChars?: number;
	locationBudgetExhausted?: () => boolean;
}

function partialLocationEvidence(session: AgentSession): string {
	const calls = new Map<string, { name: string; arguments: unknown }>(); const lines = new Set<string>();
	for (const message of session.messages) {
		if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
		if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId); if (!call) continue;
			const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			lines.add(`${message.isError ? "ERROR" : "OBSERVED"} ${call.name} ${JSON.stringify(call.arguments).slice(0, 250)}\n${text.slice(0, 300)} [excerpt]`);
		}
	}
	return "Partial code locations only: helper stopped at its safety boundary without a final report. No conclusions or acceptance are verified.\n" +
		[...lines].slice(0, 12).join("\n\n");
}

export function boundHelperReport(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = "\n[Middle omitted; report is partial. Read decisive source ranges; omitted evidence is unverified.]\n";
	const available = Math.max(0, limit - marker.length); const tail = Math.floor(available / 5);
	return text.slice(0, available - tail) + marker + text.slice(-tail);
}

export const MAX_HELPER_CONTINUATIONS = 2;
export const MAX_HELPER_STREAM_RECOVERIES = 2;

export const HELPER_CONTINUATION_PROMPT = `上一次响应因输出长度限制被截断，任务尚未完成。请在本子会话中继续原任务，保留原任务的全部限制（包括“不使用第三方库”“不需要测试”等），不要重新规划或从头重复已成功执行的工作。
以实际工具结果为准：被截断响应中的工具调用没有执行，不能把部分参数或代码视为已保存。先确认必要的文件状态；缩短推理和解释，把长文件拆成较小的 write/edit 操作，逐步完成，避免再次在一次响应中生成整个长文件。
若交付文件已经写好，只返回简短完成说明。不要因为续写而增加测试、构建或浏览器验证；用户明确跳过的检查继续跳过。`;

export const HELPER_STREAM_RECOVERY_PROMPT = `上一次模型请求的网络流中断，任务尚未完成。本次中断不是确认 token 超限，被中断响应中的工具调用没有执行，不能将草稿视为已生效。已成功执行的文件操作仍会保留。
请在本子会话中继续原任务：先检查必要的文件状态；缩短推理与输出，将长文件拆分为较小的 write/edit 操作逐步完成。
若交付文件已经写好，只返回简短完成说明。遵守原任务的全部限制（包括“不使用第三方库”“不需要测试”等），禁止自行增加测试、构建或浏览器验证；用户明确跳过的检查继续跳过。`;

const NON_STREAM_ERROR_PATTERN =
	/\b(auth|unauthorized|unauthenticated|forbidden|api[ _-]?key|quota|rate[ _-]?limit|billing|credit|insufficient|invalid[ _-]?request|bad[ _-]?request|validation|schema|permission)\b|401|403|429|400/i;

const STREAM_INTERRUPTION_PATTERNS = [
	/^(?:error:\s*)?aborted\.?$/i,
	/(?:the\s+)?(?:operation|request|stream|connection|fetch|body(?:streambuffer)?)\s+(?:was\s+)?aborted/i,
	/aborted\s+by\s+(?:peer|network|server)/i,
	/premature(?:ly)?\s+close/i,
	/closed\s+prematurely/i,
	/stream\s+ended\s+without\s+finish_reason/i,
	/未收到完整响应/i,
	/(?:connection|stream|response\s+stream)\s+terminated/i,
	/terminated\s+prematurely/i,
	/^terminated\.?$/i,
	/socket\s+hang\s+up/i,
];

export function isStreamInterruptionError(errorMessage?: string): boolean {
	if (!errorMessage || typeof errorMessage !== "string") return false;
	const trimmed = errorMessage.trim();
	if (!trimmed) return false;
	if (NON_STREAM_ERROR_PATTERN.test(trimmed)) return false;
	return STREAM_INTERRUPTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function failureDetail(
	last: AssistantMessage | undefined,
	model: Model<Api>,
	continuations: number,
	streamRecoveries = 0,
): string {
	const reason = last?.stopReason ?? "no_response";
	const description =
		reason === "length"
			? `输出达到长度限制，已续写 ${continuations} 次仍未完成`
			: reason === "aborted"
				? "模型请求被中断"
				: reason === "error"
					? streamRecoveries > 0
						? `模型请求失败，已尝试流恢复 ${streamRecoveries} 次仍未完成`
						: "模型请求失败"
					: "未返回有效的最终结果";
	return (
		`子代理 ${model.id}：${description}（stopReason=${reason}，本次输出 ${last?.usage?.output ?? 0} tokens，模型配置上限 ${model.maxTokens} tokens）。` +
		(last?.errorMessage ? `\n服务错误：${last.errorMessage}` : "") +
		"\n已成功执行的文件操作会保留；请根据工具记录接续处理，不要将此次任务视为完成。"
	);
}

/** Keep partial work and the chosen model; never replay a truncated tool call. */
export async function completeHelper(
	session: AgentSession,
	prompt: string,
	model: Model<Api>,
	signal: AbortSignal | undefined,
	onRecovery?: (message: string) => void,
	policy?: HelperCompletionPolicy,
): Promise<string> {
	const previousFinish = session.agent.finishTurn;
	const previousPrepare = session.agent.prepareRequest;
	let turns = 0; let failedTurns = 0; let finalOnly = false; let failureFinalOnly = false; let stopped: string | undefined;
	const deadline = policy ? new FusionRequestDeadline(() => {
		stopped = "Helper provider request exceeded its time limit; work remains unverified.";
		onRecovery?.(stopped); void session.abort().catch(() => undefined);
	}, policy.timeoutMs) : undefined;
	if (policy) session.agent.prepareRequest = async (request, abortSignal) => {
		const update = await previousPrepare?.(request, abortSignal);
		const reason = policy.beforeRequest?.(); if (reason) { stopped = reason; throw new Error(reason); }
		deadline?.start(); return update || undefined;
	};
	// PI rejects truncated tool arguments. End the run after those failures so even a
	// provider repeatedly returning length+tool_calls cannot create an endless loop.
	// The previous hook always runs: the session dispatches turn_end through it.
	session.agent.finishTurn = async (turn, abortSignal) => {
		deadline?.clear();
		const decision = await previousFinish?.(turn, abortSignal);
		if (policy) {
			turns++;
			const calls = turn.message.content.some((part) => part.type === "toolCall");
			failedTurns = turn.toolResults.length > 0 && turn.toolResults.every((result) => result.isError) ? failedTurns + 1 : 0;
			if (calls && policy.locationBudgetExhausted?.()) {
				if (!finalOnly) { finalOnly = true; session.setActiveToolsByName([]); return { action: "continue" }; }
				stopped = "Fast Context repeated tool calls after its location budget was exhausted.";
			}
			if (calls && failedTurns >= 3 && !failureFinalOnly && turns < policy.maxTurns && !stopped) {
				// Preserve one bounded chance to report the blocker instead of discarding
				// fusion_report/needs_escalation along with the implementation tools.
				failureFinalOnly = true;
				session.setActiveToolsByName(session.getActiveToolNames().filter((name) => ["fusion_report", "fusion_review"].includes(name)));
				return { action: "continue" };
			}
			if (calls && (turns >= policy.maxTurns || failedTurns >= 3)) stopped = "Helper reached its request or consecutive-failure safety boundary.";
			if (stopped) return { action: "end" };
		}
		if (turn.message.stopReason === "length") return { action: "end" };
		return decision || undefined;
	};
	try {
		let continuations = 0;
		let streamRecoveries = 0;
		let nextPrompt = prompt;

		while (true) {
			if (signal?.aborted) throw new Error("子代理已取消");
			await session.prompt(nextPrompt, { expandPromptTemplates: false });
			if (signal?.aborted) throw new Error("子代理已取消");
			const last = [...session.messages].reverse().find((message) => message.role === "assistant");
			if (stopped) {
				if (policy?.locationBudgetExhausted && last?.role === "assistant" && !["error", "aborted"].includes(last.stopReason))
					return boundHelperReport(partialLocationEvidence(session), policy.reportChars ?? 6000);
				throw new Error(stopped + " Already executed file operations are preserved; do not treat the task as completed.");
			}
			const activeModel = session.model ?? model;

			if (last?.role === "assistant" && last.stopReason === "length" && continuations < MAX_HELPER_CONTINUATIONS) {
				continuations++;
				onRecovery?.(
					`子代理 ${activeModel.id} 的输出被截断，正在原任务中续写（${continuations}/${MAX_HELPER_CONTINUATIONS}），保留已完成的文件操作。`,
				);
				nextPrompt = HELPER_CONTINUATION_PROMPT;
				continue;
			}

			if (
				last?.role === "assistant" &&
				last.stopReason === "error" &&
				!signal?.aborted &&
				isStreamInterruptionError(last.errorMessage) &&
				streamRecoveries < MAX_HELPER_STREAM_RECOVERIES
			) {
				streamRecoveries++;
				onRecovery?.(
					`子代理 ${activeModel.id} 的网络流中断，正在原任务中恢复（${streamRecoveries}/${MAX_HELPER_STREAM_RECOVERIES}），保留已完成的文件操作。`,
				);
				nextPrompt = HELPER_STREAM_RECOVERY_PROMPT;
				continue;
			}

			if (!last || last.role !== "assistant" || ["error", "aborted", "length"].includes(last.stopReason)) {
				throw new Error(failureDetail(last?.role === "assistant" ? last : undefined, activeModel, continuations, streamRecoveries));
			}

			const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			if (!text.trim()) {
				throw new Error(failureDetail(last, activeModel, continuations, streamRecoveries));
			}
			return boundHelperReport(text, policy?.reportChars ?? 12000);
		}
	} finally {
		session.agent.finishTurn = previousFinish;
		deadline?.clear();
		if (policy) session.agent.prepareRequest = previousPrepare;
	}
}
