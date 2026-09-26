import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export const MAX_HELPER_CONTINUATIONS = 2;

export const HELPER_CONTINUATION_PROMPT = `上一次响应因输出长度限制被截断，任务尚未完成。请在本子会话中继续原任务，保留原任务的全部限制（包括“不使用第三方库”“不需要测试”等），不要重新规划或从头重复已成功执行的工作。
以实际工具结果为准：被截断响应中的工具调用没有执行，不能把部分参数或代码视为已保存。先确认必要的文件状态；缩短推理和解释，把长文件拆成较小的 write/edit 操作，逐步完成，避免再次在一次响应中生成整个长文件。
若交付文件已经写好，只返回简短完成说明。不要因为续写而增加测试、构建或浏览器验证；用户明确跳过的检查继续跳过。`;

function failureDetail(last: AssistantMessage | undefined, model: Model<Api>, continuations: number): string {
	const reason = last?.stopReason ?? "no_response";
	const description = reason === "length"
		? `输出达到长度限制，已续写 ${continuations} 次仍未完成`
		: reason === "aborted" ? "模型请求被中断"
		: reason === "error" ? "模型请求失败"
		: "未返回有效的最终结果";
	return `子代理 ${model.id}：${description}（stopReason=${reason}，本次输出 ${last?.usage.output ?? 0} tokens，模型配置上限 ${model.maxTokens} tokens）。` +
		(last?.errorMessage ? `\n服务错误：${last.errorMessage}` : "") +
		"\n已成功执行的文件操作会保留；请根据工具记录接续处理，不要将此次任务视为完成。";
}

/** Keep partial work and the chosen model; never replay a truncated tool call. */
export async function completeHelper(
	session: AgentSession,
	prompt: string,
	model: Model<Api>,
	signal: AbortSignal | undefined,
	onRecovery?: (message: string) => void,
): Promise<string> {
	const previousFinish = session.agent.finishTurn;
	// PI rejects truncated tool arguments. End the run after those failures so even a
	// provider repeatedly returning length+tool_calls cannot create an endless loop.
	// The previous hook always runs: the session dispatches turn_end through it.
	session.agent.finishTurn = async (turn, abortSignal) => {
		const decision = await previousFinish?.(turn, abortSignal);
		if (turn.message.stopReason === "length") return { action: "end" };
		return decision || undefined;
	};
	try {
		for (let continuations = 0; ; continuations++) {
			if (signal?.aborted) throw new Error("子代理已取消");
			await session.prompt(continuations === 0 ? prompt : HELPER_CONTINUATION_PROMPT, { expandPromptTemplates: false });
			if (signal?.aborted) throw new Error("子代理已取消");
			const last = [...session.messages].reverse().find((message) => message.role === "assistant");
			if (last?.role === "assistant" && last.stopReason === "length" && continuations < MAX_HELPER_CONTINUATIONS) {
				onRecovery?.(`子代理 ${model.id} 的输出被截断，正在原任务中续写（${continuations + 1}/${MAX_HELPER_CONTINUATIONS}），保留已完成的文件操作。`);
				continue;
			}
			if (!last || last.role !== "assistant" || ["error", "aborted", "length"].includes(last.stopReason))
				throw new Error(failureDetail(last?.role === "assistant" ? last : undefined, model, continuations));
			const text = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			if (!text.trim()) throw new Error(failureDetail(last, model, continuations));
			return text.slice(0, 12000);
		}
	} finally {
		session.agent.finishTurn = previousFinish;
	}
}
