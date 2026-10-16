import type { WorkItem } from "../../../shared/transcript";

export type WorkCategory = "thinking" | "read" | "search" | "edit" | "command" | "computer" | "task" | "notice" | "tools";
export interface WorkStage {
	/** Position-based: a streaming assistant id can change when persisted. */
	id: string;
	title: string;
	category: WorkCategory;
	items: WorkItem[];
}

export function workCategory(item: WorkItem): WorkCategory {
	if (item.kind === "thinking") return "thinking";
	if (item.kind === "message") return "task";
	if (item.kind === "notice") return "notice";
	const name = item.cell.toolName;
	if (name.startsWith("computer_")) return "computer";
	if (["read", "read_file", "stat", "ls"].includes(name)) return "read";
	if (["edit", "write", "apply_patch"].includes(name)) return "edit";
	if (["bash", "powershell", "cmd", "ssh"].includes(name)) return "command";
	if (/search|grep|find|browse|fetch/.test(name)) return "search";
	if (["task", "subagent"].includes(name)) return "task";
	return "tools";
}

/** Prefer an intentional heading; normalize old conversational progress locally. */
export function workStageTitle(text: string): string {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	let inFence = false;
	let explicit = "";
	for (const line of lines) {
		if (/^(`{3,}|~{3,})/.test(line)) { inFence = !inFence; continue; }
		if (inFence) continue;
		const heading = /^(?:#{1,6}\s+(.+)|\*\*(.+?)\*\*\s*)$/.exec(line);
		if (heading) { explicit = heading[1] ?? heading[2]; break; }
	}
	const plain = (explicit || lines[0] || "")
		.replace(/^[>\-*]\s+/, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\*|__|`/g, "")
		.trim();
	if (/^[#\s]*$/.test(plain)) return "";
	let title = plain.match(/^(.+?[。！？；;]|.+?[.!?](?=\s|$))/)?.[1] ?? plain;
	// Conservative prefix removal: do not damage possessives such as “我们的读取策略”.
	const actions = "读取|检查|查看|运行|执行|验证|修改|实现|整理|分析|定位|搜索|测试|确认|构建|编译|打开|安装|修复|对比|更新|创建|删除|连接|调整";
	title = title
		.replace(new RegExp(`^(?:接下来|随后|然后|现在)(?:[，,:：\\s]+|(?=(?:我们|我|先|正在|${actions})))`), "")
		.replace(new RegExp(`^(?:我们|我)(?:将会先|将先|会先|准备|计划|打算|将要|正在|现在|将会|会|将|先|要)?\\s*(?=(?:${actions}))`), "")
		.replace(new RegExp(`^(?:先|正在)(?=(?:${actions}))`), "")
		.replace(/[。！？；;.!?:：]+$/, "")
		.trim();
	const english = title.replace(/^(?:(?:I|We)(?:['’]ll| will| am going to| are going to)?\s+(?:(?:first|now)\s+)?|Let(?:['’]s| me)\s+(?:first\s+)?|(?:Now|Next|Then),?\s+)/i, "");
	if (english !== title) title = english.replace(/^[a-z]/, (letter) => letter.toUpperCase());
	if (!explicit && /^(?:(?:need(?: to)?|now|all (?:three )?stages)\s+)?(?:report(?:ing)?|done|finish(?:ed)?|final(?: answer)?|let me begin|hmm)$/i.test(title)) return "";
	return title.length > 96 ? `${title.slice(0, 95)}…` : title;
}

/** Split explicit reasoning headings; keep every byte in an expandable detail. */
function thinkingParts(item: Extract<WorkItem, { kind: "thinking" }>): WorkItem[] {
	const lines = item.cell.thinking.split("\n");
	const parts: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (/^(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*$)/.test(line.trim()) && current.some((line) => line.trim())) {
			parts.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	parts.push(current.join("\n"));
	if (parts.length === 1) return [item];
	return parts.map((thinking, index) => ({ ...item, id: `${item.id}-part-${index}`, cell: { ...item.cell, thinking } }));
}

/** Semantic prose starts a stage; its subsequent tools live underneath it. */
export function groupWorkStages(items: readonly WorkItem[]): WorkStage[] {
	const stages: WorkStage[] = [];
	items.forEach((original, index) => {
		const parts = original.kind === "thinking" ? thinkingParts(original) : [original];
		parts.forEach((item, part) => {
			const category = workCategory(item);
			const previous = stages[stages.length - 1];
			// Internal wrap-up reasoning without a subsequent action is detail, not a new task.
			if (previous && item.kind === "thinking"
				&& (!workStageTitle(item.cell.thinking) || !items.slice(index + 1).some((entry) => entry.kind === "tool" || entry.kind === "message"))
				&& !items.some((entry) => entry.kind === "message" && entry.cell.id === item.cell.id)) {
				previous.items.push(item);
				return;
			}
			const prose = item.kind === "thinking" || item.kind === "message";
			// Thinking and commentary from the same response describe the same step.
			const sameResponse = item.kind === "message" && previous?.items.some((entry) => entry.kind === "thinking" && entry.cell.id === item.cell.id);
			const hasProse = previous?.items.some((entry) => entry.kind === "thinking" || entry.kind === "message");
			if (previous && (sameResponse || (!prose && (hasProse || category === previous.category || item.kind === "notice")))) {
				previous.items.push(item);
				if (sameResponse && item.kind === "message") {
					// User-facing progress is more useful than an internal reasoning lead-in.
					previous.title = workStageTitle(item.cell.text) || previous.title;
					previous.category = "task";
				}
				return;
			}
			const args = item.kind === "tool" && typeof item.cell.args === "object" && item.cell.args !== null
				? item.cell.args as Record<string, unknown> : undefined;
			const description = typeof args?.description === "string" ? args.description : "";
			const text = item.kind === "thinking" ? item.cell.thinking : item.kind === "message" || item.kind === "notice" ? item.cell.text : description;
			stages.push({ id: `stage-${index}-${part}`, title: workStageTitle(text), category, items: [item] });
		});
	});
	return stages;
}
