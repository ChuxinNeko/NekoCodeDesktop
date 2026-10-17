import type { WorkItem } from "../../../shared/transcript";
import type { Language, TranslateFn } from "../i18n";

export type WorkCategory = "thinking" | "read" | "search" | "edit" | "command" | "computer" | "task" | "notice" | "tools";
export interface WorkStage {
	/** Position-based: a streaming assistant id can change when persisted. */
	id: string;
	title: string;
	titleSource?: "heading" | "tool";
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

/** Only Markdown headings outside code fences are intentional stage labels. */
function stageHeadings(text: string): { line: number; text: string }[] {
	const headings: { line: number; text: string }[] = [];
	let fence: { marker: string; length: number } | null = null;
	text.split("\n").forEach((raw, line) => {
		const value = raw.trim();
		const delimiter = /^(`{3,}|~{3,})(.*)$/.exec(value);
		if (delimiter) {
			if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length };
			else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
			return;
		}
		if (fence || /^(?: {4}|\t)/.test(raw)) return;
		const match = /^(?:#{1,6}\s+(.+?)(?:\s+#+)?|\*\*(.+?)\*\*)$/.exec(value);
		if (match) headings.push({ line, text: match[1] ?? match[2] });
	});
	return headings;
}

/** Reject narrative, generic internal cues and titles in a different UI language.
 * Missing titles fall back to actual tool activity, never a sentence from prose.
 */
function conciseTitle(text: string, language: Language): string {
	const title = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*|__|`/g, "").trim();
	if (!title || /[\r\n。！？；;!?，,]/.test(title) || /\.(?=\s|$)|[:：]$/.test(title)) return "";
	if (title.length > (language === "zh-CN" ? 32 : 72) || title.split(/\s+/).length > 8) return "";
	if (/^(?:我(?:们)?|接下来|随后|然后|现在|正在|先来|让我们)/.test(title)) return "";
	if (/^(?:(?:I|We|Let(?:['’]s| me)|Need to|Now|Next|Then)\b)/i.test(title)) return "";
	if (/^(?:thinking|analysis|report(?:ing)?|done|finish(?:ed)?|final(?: answer)?|follow the skill|planning next step|next step|hmm|思考|分析|下一步|遵循技能|整理结果)$/i.test(title)) return "";
	const chinese = /[\p{Script=Han}]/u.test(title);
	if (language === "zh-CN" ? !chinese : chinese) return "";
	return title;
}

export function workStageTitle(text: string, language: Language = "zh-CN"): string {
	for (const heading of stageHeadings(text)) {
		const title = conciseTitle(heading.text, language);
		if (title) return title;
	}
	return "";
}

function toolDescription(item: WorkItem, language: Language): string {
	if (item.kind !== "tool" || typeof item.cell.args !== "object" || item.cell.args === null) return "";
	const description = (item.cell.args as Record<string, unknown>).description;
	if (typeof description !== "string") return "";
	if (!/^(?:读取|检查|查看|运行|执行|验证|修改|实现|整理|定位|搜索|测试|确认|构建|编译|打开|安装|修复|对比|更新|创建|删除|连接|调整|Read(?:ing)?\b|Check(?:ing)?\b|Inspect(?:ing)?\b|Search(?:ing)?\b|Run(?:ning)?\b|Test(?:ing)?\b|Verify(?:ing)?\b|Fix(?:ing)?\b|Build(?:ing)?\b|Update?\b|Edit(?:ing)?\b)/i.test(description)) return "";
	return conciseTitle(description, language);
}

/** Localized fallback for live work and old history without a usable heading. */
export function workStageLabel(stage: WorkStage, t: TranslateFn): string {
	if (stage.title) return stage.title;
	const tool = stage.items.find((item) => item.kind === "tool");
	if (!tool || tool.kind !== "tool") return t(`workFlow.${stage.category}`);
	const category = workCategory(tool);
	const tools = stage.items.filter((item) => item.kind === "tool");
	if (tools.length > 1) {
		const categories = new Set(tools.map(workCategory));
		if (categories.size === 1) return t(`workFlow.${category}`);
		return [...categories].every((category) => category === "read" || category === "search")
			? t("workFlow.investigate") : t("workFlow.activity");
	}
	const args = typeof tool.cell.args === "object" && tool.cell.args !== null ? tool.cell.args as Record<string, unknown> : {};
	const path = args.path ?? args.file_path ?? args.filePath;
	if ((category === "read" || category === "edit") && typeof path === "string") {
		const name = path.split(/[\\/]/).filter(Boolean).pop()?.replace(/[\r\n]/g, " ");
		if (name) return t(category === "read" ? "workFlow.readFile" : "workFlow.editFile", { name: name.length > 40 ? `${name.slice(0, 39)}…` : name });
	}
	return t(`workFlow.${category}`);
}

/** Split actual headings, preserving code examples and every byte of detail. */
function proseParts(item: Extract<WorkItem, { kind: "thinking" | "message" }>): WorkItem[] {
	const text = item.kind === "thinking" ? item.cell.thinking : item.cell.text;
	const lines = text.split("\n");
	const boundaries = new Set(stageHeadings(text).map((heading) => heading.line));
	const parts: string[] = [];
	let current: string[] = [];
	lines.forEach((line, index) => {
		if (boundaries.has(index) && current.some((line) => line.trim())) {
			parts.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	});
	parts.push(current.join("\n"));
	if (parts.length === 1) return [item];
	return parts.map((text, index) => ({ ...item, id: `${item.id}-part-${index}`, cell: { ...item.cell, ...(item.kind === "thinking" ? { thinking: text } : { text }) } }));
}

/** Semantic prose starts a stage; its subsequent tools live underneath it. */
export function groupWorkStages(items: readonly WorkItem[], language: Language = "zh-CN"): WorkStage[] {
	const stages: WorkStage[] = [];
	items.forEach((original, index) => {
		const parts = original.kind === "thinking" || original.kind === "message" ? proseParts(original) : [original];
		parts.forEach((item, part) => {
			const category = workCategory(item);
			const previous = stages[stages.length - 1];
			// Internal wrap-up reasoning without a subsequent action is detail, not a new task.
			if (previous && item.kind === "thinking"
				&& !items.slice(index + 1).some((entry) => entry.kind === "tool" || entry.kind === "message")
				&& !items.some((entry) => entry.kind === "message" && entry.cell.id === item.cell.id)) {
				previous.items.push(item);
				return;
			}
			const prose = item.kind === "thinking" || item.kind === "message";
			// Thinking and commentary from the same response describe the same step.
			const sameResponse = part === 0 && item.kind === "message" && previous?.items.some((entry) => entry.kind === "thinking" && entry.cell.id === item.cell.id);
			const hasProse = previous?.items.some((entry) => entry.kind === "thinking" || entry.kind === "message");
			const previousTool = previous?.items.find((entry) => entry.kind === "tool");
			const previousCategory = previousTool ? workCategory(previousTool) : null;
			const sameActivity = previousCategory === category || (["read", "search"].includes(previousCategory ?? "") && ["read", "search"].includes(category));
			const withinObjective = hasProse && (previous.titleSource === "heading" || !previousTool || sameActivity);
			if (previous && (sameResponse || (!prose && (withinObjective || category === previous.category || item.kind === "notice")))) {
				previous.items.push(item);
				if (item.kind === "tool" && !previous.title) {
					previous.title = toolDescription(item, language);
					if (previous.title) previous.titleSource = "tool";
				}
				if (sameResponse && item.kind === "message") {
					// User-facing progress is more useful than an internal reasoning lead-in.
					const heading = workStageTitle(item.cell.text, language);
					if (heading) { previous.title = heading; previous.titleSource = "heading"; }
					previous.category = "task";
				}
				return;
			}
			const text = item.kind === "thinking" ? item.cell.thinking : item.kind === "message" ? item.cell.text : "";
			const heading = workStageTitle(text, language);
			stages.push({ id: `stage-${index}-${part}`, title: heading || toolDescription(item, language), titleSource: heading ? "heading" : "tool", category, items: [item] });
		});
	});
	return compactWorkStages(stages);
}

/** Repeated model responses are details within a phase, not phase boundaries. */
function compactWorkStages(stages: WorkStage[]): WorkStage[] {
	const compact: WorkStage[] = [];
	const isFileHeading = (title: string) => /^(?:读取|查看|检查|搜索|编辑|修改|Read|Inspect|Search|Edit)\s*[\w@.~/\\:+-]+\.[a-z0-9]{1,10}$/i.test(title);
	for (const stage of stages) {
		const previous = compact[compact.length - 1];
		// A filename-only heading still describes one call, not a new objective.
		const fileHeading = isFileHeading(stage.title);
		const newHeading = stage.titleSource === "heading" && !fileHeading && stage.title !== previous?.title;
		if (previous && !newHeading) {
			previous.items.push(...stage.items);
			// Tool descriptions and filenames cannot stand for a whole merged phase.
			if (previous.titleSource !== "heading" || isFileHeading(previous.title)) previous.title = "";
			continue;
		}
		compact.push(stage);
	}
	return compact;
}
