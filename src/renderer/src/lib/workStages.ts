import type { WorkItem } from "../../../shared/transcript";
import type { Language, TranslateFn, TranslationKey } from "../i18n";

export type WorkCategory = "thinking" | "read" | "search" | "edit" | "command" | "computer" | "task" | "notice" | "tools";
type WorkPhase = "investigate" | "implement" | "verify" | "build" | "install" | "preview" | "computer" | "task" | "command" | "tools" | "thinking" | "notice";
type WorkTopic = "entry" | "ui" | "theme" | "tests" | "source" | "results" | "general";
export interface WorkStage {
	/** Position-based: a streaming assistant id can change when persisted. */
	id: string;
	title: string;
	titleSource?: "heading" | "tool";
	category: WorkCategory;
	items: WorkItem[];
	phase?: WorkPhase;
	topic?: WorkTopic;
}

export function workCategory(item: WorkItem): WorkCategory {
	if (item.kind === "thinking") return "thinking";
	if (item.kind === "message") return "task";
	if (item.kind === "notice") return "notice";
	const name = item.cell.toolName;
	if (name.startsWith("computer_")) return "computer";
	if (["read", "read_file", "stat", "ls"].includes(name)) return "read";
	if (["edit", "write", "apply_patch"].includes(name)) return "edit";
	if (["bash", "powershell", "cmd", "ssh", "exec_command", "shell", "terminal"].includes(name)) return "command";
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
	if (/^(?:Evaluating|Assessing|Clarifying|Considering|Reasoning|Thinking|Planning)(?:\b|[:：])/i.test(title)) return "";
	if (/^(?:思考与规划|处理任务|执行命令|使用工具|分析细节|评估实现细节|评估令牌预算)$/.test(title)) return "";
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
	if (!/^(?:读取|检查|查看|运行|执行|验证|修改|实现|整理|定位|搜索|测试|确认|确定|梳理|追踪|分析|保留|移植|接入|清理|补充|构建|编译|打开|安装|修复|对比|更新|创建|删除|连接|调整|Read(?:ing)?\b|Check(?:ing)?\b|Inspect(?:ing)?\b|Search(?:ing)?\b|Run(?:ning)?\b|Test(?:ing)?\b|Verify(?:ing)?\b|Fix(?:ing)?\b|Build(?:ing)?\b|Update?\b|Edit(?:ing)?\b)/i.test(description)) return "";
	return conciseTitle(description, language);
}

/** A file path is detail, not a stage objective. */
function fileTitle(title: string): boolean {
	return /^(?:读取|查看|检查|搜索|编辑|修改|Read|Inspect|Search|Edit)\s*[\w@.~/\\:+-]+\.[a-z0-9]{1,10}$/i.test(title);
}

const fallbackKeys: Record<WorkPhase, TranslationKey> = {
	investigate: "workFlow.stage.inspect", implement: "workFlow.stage.implement",
	verify: "workFlow.stage.verify", build: "workFlow.stage.build", install: "workFlow.stage.install",
	preview: "workFlow.stage.preview", computer: "workFlow.stage.computer", task: "workFlow.stage.task",
	command: "workFlow.stage.command", tools: "workFlow.stage.tools", thinking: "workFlow.stage.thinking", notice: "workFlow.stage.notice",
};
const inspectKeys: Partial<Record<WorkTopic, TranslationKey>> = {
	entry: "workFlow.stage.inspectEntry", ui: "workFlow.stage.inspectUi", theme: "workFlow.stage.inspectTheme",
	tests: "workFlow.stage.inspectTests", source: "workFlow.stage.inspectSource", results: "workFlow.stage.inspectResults",
};
const implementKeys: Partial<Record<WorkTopic, TranslationKey>> = {
	entry: "workFlow.stage.editEntry", ui: "workFlow.stage.editUi", theme: "workFlow.stage.editTheme",
	tests: "workFlow.stage.editTests", source: "workFlow.stage.editSource",
};

/** Labels describe a phase's purpose, never a command, filename or internal state. */
export function workStageLabel(stage: WorkStage, t: TranslateFn): string {
	if (stage.title && !fileTitle(stage.title)) return stage.title;
	const phase = stage.phase ?? (stage.category === "read" || stage.category === "search" ? "investigate" : stage.category === "edit" ? "implement" : stage.category);
	const key = phase === "investigate" ? inspectKeys[stage.topic ?? "general"]
		: phase === "implement" ? implementKeys[stage.topic ?? "general"] : undefined;
	return t(key ?? fallbackKeys[phase]);
}

/** Empty/whitespace placeholders must never create an expandable stage. */
export function workStageHasDetails(stage: Pick<WorkStage, "items">): boolean {
	return stage.items.some(hasDetails);
}
function hasDetails(item: WorkItem): boolean {
	const text = item.kind === "thinking" ? item.cell.thinking : item.kind === "message" || item.kind === "notice" ? item.cell.text : null;
	return text === null || text.replace(/[#*_`\s]/g, "").length > 0;
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

function argsOf(item: WorkItem): Record<string, unknown> {
	return item.kind === "tool" && typeof item.cell.args === "object" && item.cell.args !== null ? item.cell.args as Record<string, unknown> : {};
}

/** Infer intent only from input metadata, never tool output or source-code bodies. */
function toolActivity(item: Extract<WorkItem, { kind: "tool" }>, edited: boolean): { phase: WorkPhase | null; topic: WorkTopic } {
	const args = argsOf(item);
	const description = typeof args.description === "string" ? args.description : "";
	const command = String(args.command ?? args.cmd ?? "");
	const path = String(args.path ?? args.file_path ?? args.filePath ?? "");
	const metadata = `${description} ${path} ${command}`;
	const topic: WorkTopic = /(?:构建结果|构建日志|验证记录|(?:build|typecheck|test)[^\s]*\.log|\/tmp\/[^\s]*\.log)/i.test(metadata) ? "results"
		: /(?:主题|样式|变量|布局常量|theme|foundation\.css|index\.css|\.css\b|tailwind)/i.test(metadata) ? "theme"
		: /(?:上游|组件来源|源码追溯|原始组件|接入约定|upstream|registry|beautifului\.dev)/i.test(metadata) ? "source"
		: /(?:测试|断言|(?:^|[ /])tests?\/|\.(?:test|spec)\.)/i.test(metadata) ? "tests"
		: /(?:组件|侧栏|消息|输入|界面|交互|sidebar|transcript|composer|markdown|components[\/\\])/i.test(metadata) ? "ui"
		: /(?:入口|启动|配置|package\.json|(?:vite|tsconfig)|(?:server|index|main|app)\.[cm]?[jt]sx?)/i.test(metadata) ? "entry" : "general";
	const name = item.cell.toolName;
	const category = workCategory(item);
	const localPage = name === "browser_navigate" && typeof args.url === "string" && /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)|file:\/\/)/i.test(args.url);
	if (edited && (localPage || ["browser_viewport", "browser_evaluate", "browser_screenshot", "browser_action"].includes(name))) return { phase: "preview", topic: "ui" };
	if (category === "command") {
		// Match executable positions, not an echo mentioning tests or code passed to a writer.
		const executable = (pattern: string) => new RegExp(`(?:^|[;&|]\\s*)(?:[A-Z_][A-Z_0-9]*=(?:"[^"]*"|'[^']*'|[^\\s]+)\\s+)*(?:${pattern})(?=\\s|$)`, "i").test(command.trim());
		if (executable("(?:bun|npm|pnpm|yarn|npx)\\s+(?:run\\s+)?(?:test|typecheck|lint|vitest|tsc)|pytest|vitest|playwright|tsc") || /^(?:测试|验证|复测|运行.*测试|检查.*(?:类型|兼容))/.test(description)) return { phase: "verify", topic };
		if (executable("(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?build|vite\\s+build|electron-vite\\s+build") || /^(?:编译|构建)/.test(description)) return { phase: "build", topic };
		if (executable("(?:bun|npm|pnpm|yarn)\\s+(?:install|add)|(?:bunx|npx)\\s+(?:--yes\\s+|-y\\s+)?shadcn(?:@[^\\s]+)?") || /^(?:安装)/.test(description)) return { phase: "install", topic };
		if (/^(?:修改|实现|移植|保留|接入|清理|修复|更新|创建|删除|调整|补充)/.test(description)) return { phase: "implement", topic };
		if (executable("(?:cat|sed|head|tail|ls|stat|rg|grep|find|git\\s+(?:status|diff|show)|curl|wget)") || /^(?:读取|查看|检查|检索|搜索|定位|确认|确定)/.test(description)) return { phase: "investigate", topic };
		return { phase: null, topic };
	}
	return { phase: category === "read" || category === "search" ? "investigate" : category === "edit" ? "implement" : category === "tools" ? null : category, topic };
}

/** Similar consecutive work shares a phase; actual execution changes end old plans. */
export function groupWorkStages(items: readonly WorkItem[], language: Language = "zh-CN"): WorkStage[] {
	const stages: WorkStage[] = [];
	let pending: WorkItem[] = [];
	let pendingId = "";
	let edited = false;
	const appendPending = (stage: WorkStage) => { stage.items.push(...pending); pending = []; pendingId = ""; };
	items.forEach((original, index) => {
		if (!hasDetails(original)) return;
		const parts = original.kind === "thinking" || original.kind === "message" ? proseParts(original) : [original];
		parts.forEach((item, part) => {
			if (!hasDetails(item)) return;
			let previous = stages.at(-1);
			const prose = item.kind === "thinking" || item.kind === "message";
			const text = item.kind === "thinking" ? item.cell.thinking : item.kind === "message" ? item.cell.text : "";
			const candidate = prose ? workStageTitle(text, language) : toolDescription(item, language);
			const title = fileTitle(candidate) ? "" : candidate;
			if (prose) {
				if (!title) { if (!pending.length) pendingId = `stage-${index}-${part}`; pending.push(item); return; }
				// A later part of this response may carry another intentional objective.
				const sameResponse = part === 0 && item.kind === "message" && previous?.items.some(entry => entry.kind === "thinking" && entry.cell.id === item.cell.id);
				if (previous && (previous.title === title || (sameResponse && !previous.items.some(entry => entry.kind === "tool")))) {
					appendPending(previous); previous.items.push(item);
					previous.title = title; previous.titleSource = "heading";
					if (item.kind === "message") previous.category = "task";
				} else {
					stages.push({ id: `stage-${index}-${part}`, title, titleSource: "heading", category: workCategory(item), items: [...pending, item] });
					pending = []; pendingId = "";
				}
				return;
			}
			if (item.kind === "notice") {
				if (previous) { appendPending(previous); previous.items.push(item); }
				else { if (!pending.length) pendingId = `stage-${index}-${part}`; pending.push(item); }
				return;
			}
			if (item.kind !== "tool") return;
			const activity = toolActivity(item, edited);
			const previousHasTool = previous?.items.some(entry => entry.kind === "tool");
			const plan = previous?.titleSource === "heading" && /设计|规划|方案|页面结构|\b(?:design|plan|architecture)\b/i.test(previous.title);
			const phaseChanged = previousHasTool && activity.phase && previous?.phase && activity.phase !== previous.phase;
			const planEnded = !previousHasTool && plan && activity.phase && ["implement", "verify", "build", "preview", "install"].includes(activity.phase);
			const topicChanged = previousHasTool && previous?.titleSource !== "heading" && activity.phase === previous?.phase &&
				activity.topic !== "general" && previous?.topic !== "general" && activity.topic !== previous?.topic;

			if (!previous || phaseChanged || planEnded || topicChanged) {
				previous = { id: pendingId || `stage-${index}-${part}`, title, titleSource: title ? "tool" : undefined, category: workCategory(item), phase: activity.phase ?? (workCategory(item) === "tools" ? "tools" : "command"), topic: activity.topic, items: [] };
				stages.push(previous);
			} else {
				if (!previous.phase) previous.phase = activity.phase ?? (workCategory(item) === "tools" ? "tools" : "command");
				if (!previous.topic || previous.topic === "general") previous.topic = activity.topic;
				if (!previous.title && title) { previous.title = title; previous.titleSource = "tool"; }
			}
			appendPending(previous);
			previous.items.push(item);
			if (activity.phase === "implement") edited = true;
		});
	});
	if (pending.length) {
		const previous = stages.at(-1);
		if (previous) appendPending(previous);
		else stages.push({ id: "stage-0-0", title: "", category: workCategory(pending[0]), items: pending });
	}
	return stages;
}

/** Tool completion is not stage completion: the model may still retry or inspect results.
 * Until the protocol carries stage status, require an explicit progress completion message.
 */
export function workStageCompleted(stage: WorkStage | undefined): boolean {
	if (!stage) return false;
	const tools = stage.items.filter(item => item.kind === "tool");
	if (!tools.length || tools.some(item => item.cell.status === "pending" || item.cell.status === "running")) return false;
	let lastTool = -1;
	stage.items.forEach((item, index) => { if (item.kind === "tool") lastTool = index; });
	const progress = stage.items.slice(lastTool + 1).filter(item => item.kind === "message");
	const latest = progress[progress.length - 1];
	if (!latest || latest.kind !== "message" || latest.cell.streaming) return false;
	return latest.cell.text.split(/\r?\n/).some(line =>
		/^(?:本阶段|当前阶段|这一阶段|这一步)(?:的工作|工作|任务)?(?:已全部完成|已经完成|已完成|完成了)[。.!！\s]*$/.test(line.trim())
		|| /^(?:this|the current) (?:stage|phase|step) (?:is (?:now )?complete|has been completed)[.!\s]*$/i.test(line.trim()));
}
