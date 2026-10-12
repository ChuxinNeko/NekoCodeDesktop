import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { FUSION_DOCUMENT_RETURN } from "./fusion-document-budget";

const excerpt = (text: string, limit: number) => text.length <= limit ? text :
	text.slice(0, Math.floor(limit / 2)) + "\n[excerpt; omitted content is not verified]\n" + text.slice(-Math.floor(limit / 2));
const textOf = (message: AgentMessage): string => "content" in message ? typeof message.content === "string" ? message.content :
	message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";

function implementationSummary(messages: AgentMessage[]): string {
	const calls = new Map<string, ToolCall>();
	const observations: string[] = [];
	const changed = new Set<string>();
	let report: ToolCall | undefined;
	let reported = false;
	let lastText = "";
	for (const message of messages) {
		if (message.role === "custom" && message.customType === FUSION_DOCUMENT_RETURN)
			observations.push(`Runtime handoff (not acceptance): ${textOf(message)}`);
		if (message.role === "assistant") {
			lastText = textOf(message) || lastText;
			for (const part of message.content) if (part.type === "toolCall") {
				calls.set(part.id, part);
				if (part.name === "fusion_review") report = part;
			}
		}
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		if (!call) continue;
		if (call.name === "fusion_review") {
			reported = !message.isError;
			if (message.isError) observations.push(`ERROR fusion_review\n${excerpt(textOf(message), 900)}`);
			continue;
		}
		const args = call.arguments as Record<string, unknown>;
		const path = typeof args.path === "string" ? args.path : "";
		if (["write", "edit", "ast_edit"].includes(call.name)) {
			if (!message.isError && path) changed.add(path);
			const detail = call.name === "edit" ?
				`\nold: ${excerpt(String(args.oldText ?? ""), 350)}\nnew: ${excerpt(String(args.newText ?? ""), 350)}` :
				call.name === "write" ? ` (${String(args.content ?? "").length} characters written; content omitted)` :
				`\narguments: ${excerpt(JSON.stringify(args), 700)}`;
			observations.push(`${message.isError ? "ERROR" : "OK"} ${call.name} ${path}${detail}\n${excerpt(textOf(message), 400)}`);
		} else if (message.isError || ["bash", "powershell"].includes(call.name) || call.name.startsWith("mcp__")) {
			observations.push(`${message.isError ? "ERROR" : "OBSERVED"} ${call.name} ${excerpt(JSON.stringify(args), 400)}\n${excerpt(textOf(message), 900)}`);
		}
	}
	// Reported acceptance remains a claim for Lead to review, never inferred from tool success.
	let acceptance = "No successful structured fusion_review report. All acceptance remains unverified.";
	if (report && reported) {
		const args = report.arguments as Record<string, unknown>;
		const items = Array.isArray(args.acceptance) ? args.acceptance : [];
		acceptance = `Sidekick report (claims, not independent verification):\nOutcome: ${args.outcome}\n${excerpt(String(args.summary ?? ""), 1800)}\n` +
			items.map((item) => `${item.status}: ${excerpt(String(item.criterion), 250)} — ${excerpt(String(item.evidence), 400)}`).join("\n") +
			(args.decision ? `\nDecision requested: ${excerpt(String(args.decision), 1800)}` : "");
	}
	return "Fusion implementation context summary. Full raw messages remain in the session history. " +
		"Intermediate reads, generated file bodies and verbose logs are omitted from this Lead request. " +
		"Read decisive file ranges before acceptance; excerpts cannot prove omitted checks.\n" +
		excerpt(acceptance, 8500) + "\nSuccessful write/edit tool paths (content changes require verification): " + excerpt([...changed].join(", ") || "none observed", 1200) +
		"\nActual tool observations (OK means tool success only):\n" + excerpt(observations.join("\n\n") || "none", 4500) +
		"\nLast Sidekick text (not verification):\n" + excerpt(lastText, 600);
}

/** Request-only projection: never edit the canonical transcript or Sidekick's context. */
export function projectFusionLeadContext(messages: AgentMessage[]): AgentMessage[] {
	const projected: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		projected.push(message);
		if (message.role !== "assistant") continue;
		const handoff = message.content.find((part) => part.type === "toolCall" && part.name === "fusion_implement");
		if (!handoff || handoff.type !== "toolCall") continue;
		// Preserve the entire handoff tool batch, including denied same-batch effects.
		let start = i + 1;
		let accepted = false;
		while (start < messages.length && messages[start]!.role === "toolResult") {
			const result = messages[start]!;
			if (result.role === "toolResult" && result.toolCallId === handoff.id) accepted = !result.isError;
			projected.push(result);
			start++;
		}
		if (!accepted) { i = start - 1; continue; }
		let end = start;
		let reviewId: string | undefined;
		let sealed = false;
		for (; end < messages.length; end++) {
			const current = messages[end]!;
			if (current.role === "custom" && current.customType === FUSION_DOCUMENT_RETURN) {
				sealed = true; end++; break;
			}
			if (current.role === "user" || current.role === "compactionSummary" || current.role === "branchSummary") break;
			if (current.role === "assistant") {
				if (current.content.some((part) => part.type === "toolCall" && part.name === "fusion_implement")) break;
				const review = current.content.find((part) => part.type === "toolCall" && part.name === "fusion_review");
				if (review?.type === "toolCall") reviewId = review.id;
				// A text-only finish returns control to Lead even when the report is missing.
				if (!current.content.some((part) => part.type === "toolCall")) { sealed = true; end++; break; }
			}
			if (current.role === "toolResult" && current.toolCallId === reviewId && !current.isError) {
				sealed = true;
				end++;
				// Keep denied calls after the report in this batch paired inside the summary.
				while (end < messages.length && messages[end]!.role === "toolResult") end++;
				break;
			}
		}
		if (end > start) {
			const segment = messages.slice(start, end);
			// Never rewrite an open segment that Lead may already have seen during recovery.
			// Closed segments have a fixed boundary: subsequent requests append after them.
			if (!sealed) {
				projected.push(...segment);
				i = end - 1;
				continue;
			}
			const summary = implementationSummary(segment);
			const implementation = segment.filter((entry) => entry.role !== "system");
			// Short tasks should not become more expensive solely because of summary framing.
			if (summary.length >= JSON.stringify(implementation).length) {
				projected.push(...segment);
				i = end - 1;
				continue;
			}
			// Tool declarations and system instructions are owned by the SDK, not this projection.
			projected.push(...segment.filter((entry) => entry.role === "system"));
			if (segment.some((entry) => entry.role === "assistant" || entry.role === "toolResult"))
				projected.push({ role: "user", content: summary, timestamp: messages[end - 1]!.timestamp });
		}
		i = end - 1;
	}
	return projected;
}

/** Keep each previously exposed Lead prefix unchanged while raw history only appends. */
export class FusionLeadContextProjection {
	private rawPrefix: string[] = [];
	private sentPrefix: string[] = [];
	private sentMessages: AgentMessage[] = [];
	project(messages: AgentMessage[]): AgentMessage[] {
		const raw = messages.map((message) => JSON.stringify(message));
		let candidate = projectFusionLeadContext(messages);
		const appending = raw.length >= this.rawPrefix.length && this.rawPrefix.every((value, index) => raw[index] === value);
		if (appending && this.sentPrefix.length && !this.sentPrefix.every((value, index) => JSON.stringify(candidate[index]) === value)) {
			// An interrupted segment may have been exposed before it could be sealed. Keep
			// that prefix instead of trading an existing cache entry for a shorter rewrite.
			candidate = [...this.sentMessages, ...projectFusionLeadContext(messages.slice(this.rawPrefix.length))];
		}
		this.rawPrefix = raw;
		this.sentPrefix = candidate.map((message) => JSON.stringify(message));
		this.sentMessages = candidate;
		return candidate;
	}
	reset(): void { this.rawPrefix = []; this.sentPrefix = []; this.sentMessages = []; }
}
