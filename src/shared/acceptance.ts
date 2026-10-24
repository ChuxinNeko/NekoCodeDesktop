import type { AgentCell } from "./agent";
import { isShellTool } from "./hooks";

export type AcceptanceStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "unverified" | "stale";
export interface AcceptanceCheck {
	id: string;
	title: string;
	kind: "command" | "browser" | "requirement";
	status: AcceptanceStatus;
	previousStatus?: "passed" | "failed";
	toolCallId: string;
	evidenceToolCallIds: string[];
	command?: string;
	exitCode?: number;
	uncertainCommand?: boolean;
	url?: string;
	viewport?: { width: number; height: number };
	reason?: string;
	output: string;
	outputTruncated: boolean;
	startedAt: number;
	finishedAt?: number;
}
export interface AcceptanceTurn {
	id: string;
	title: string;
	timestamp: number;
	checks: AcceptanceCheck[];
	changedPaths: string[];
	possibleShellChanges: boolean;
	streaming: boolean;
	omittedChecks: number;
}
export interface AcceptanceReport {
	version: 1;
	turns: AcceptanceTurn[];
	omittedTurns: number;
}

type Tool = Extract<AgentCell, { type: "tool" }>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 240): string => typeof value === "string" ? value.slice(0, max) : "";
const VALIDATION = /^(?:(?:bun|npm|pnpm|yarn)\s+(?:(?:run|exec)\s+)?(?:test|typecheck|lint|check|build)(?=\s|[:;&|>]|$)|(?:npx\s+)?(?:tsc|vue-tsc|eslint|biome\s+check|vitest|jest|playwright\s+test|pytest)(?=\s|[;&|>]|$)|python(?:3)?\s+-m\s+(?:pytest|unittest)(?=\s|[;&|>]|$)|(?:cargo|go|dotnet|mvn|gradle)\s+(?:test|check|build|clippy)(?=\s|[;&|>]|$))/i;
export function isValidationCommand(command: string): boolean { return VALIDATION.test(command.trim()); }

/** Conservative: an unknown shell command may change sources, even if it exits unsuccessfully. */
function mayChange(tool: Tool): boolean {
	if (["edit", "write", "ast_edit", "apply_patch", "file_write", "file_edit"].includes(tool.toolName)) return tool.status !== "pending" || !tool.inputStreaming;
	if (!isShellTool(tool.toolName) || tool.inputStreaming) return false;
	const command = text(record(tool.args).command, 30_000).trim();
	if (/[>`$]|--(?:fix|write)\b/i.test(command)) return true;
	return !command.split(/\r?\n|&&|;|\|\|?/).filter(part => part.trim()).every(part => isValidationCommand(part) || /^\s*(?:git\s+(?:status|diff|log|show|ls-files|rev-parse)\b|(?:rg|grep|cat|head|tail|ls|pwd|Get-Content|Get-ChildItem|Get-Location|Select-Object|Select-String)\b)/i.test(part));
}

function observedCheck(tool: Tool, includeCommand = false): AcceptanceCheck | null {
	const args = record(tool.args), details = record(tool.details);
	const command = isShellTool(tool.toolName) ? text(args.command, 2000) : "";
	const browser = tool.toolName === "browser_check" ? record(details.acceptanceEvidence) : {};
	if (!command && !Object.keys(browser).length && tool.toolName !== "browser_check") return null;
	if (command && !includeCommand && !isValidationCommand(command)) return null;
	const execution = record(details.execution);
	const code = execution.exitCode ?? details.exitCode ?? details.exit_code;
	const exitCode = typeof code === "number" && Number.isInteger(code) ? code : undefined;
	// A final zero exit code in a shell script may mask failed earlier checks or later edits.
	const uncertainCommand = !!command && (/[;\n\r|>]/.test(command) || command.split("&&").slice(1).some(part => !isValidationCommand(part)));
	const running = tool.status === "pending" || tool.status === "running";
	const interrupted = tool.status === "error" && /(?:Command aborted|Command timed out|Command terminated without an exit code|interaction cancelled|tool call cancelled)/i.test(tool.output);
	const status: AcceptanceStatus = running ? (tool.inputStreaming ? "pending" : "running") : interrupted ? "unverified" : tool.status === "error" ? "failed" :
		command ? (exitCode === undefined ? "unverified" : exitCode !== 0 ? "failed" : uncertainCommand ? "unverified" : "passed") :
		browser.status === "passed" ? "passed" : browser.status === "failed" ? "failed" : "unverified";
	const viewport = record(browser.viewport);
	const fullOutput = tool.output;
	return {
		id: tool.toolCallId, title: text(browser.title) || text(args.title) || command || "browser_check", kind: command ? "command" : "browser", status,
		toolCallId: tool.toolCallId, evidenceToolCallIds: [tool.toolCallId], ...(command ? { command } : {}),
		...(exitCode !== undefined ? { exitCode } : {}), ...(typeof browser.url === "string" ? { url: text(browser.url, 1000) } : {}),
		...(uncertainCommand ? { uncertainCommand: true } : {}),
		...(typeof viewport.width === "number" && typeof viewport.height === "number" ? { viewport: { width: viewport.width, height: viewport.height } } : {}),
		output: fullOutput.slice(-1000), outputTruncated: fullOutput.length > 1000 || (tool.outputTotal ?? 0) > fullOutput.length,
		startedAt: tool.startedAt ?? tool.timestamp, ...(!running ? { finishedAt: tool.timestamp } : {}),
	};
}

/** Only execution evidence can satisfy a requirement. A model's prose cannot. */
export function requirementStatus(requested: string, evidence: AcceptanceCheck[]): AcceptanceStatus {
	if (requested === "pending" || requested === "skipped" || requested === "unverified") return requested;
	if (!evidence.length || evidence.some(item => item.status === "unverified" || item.status === "pending" || item.status === "running" || item.status === "skipped")) return "unverified";
	if (evidence.some(item => item.status === "stale")) return "stale";
	if (evidence.some(item => item.status === "failed")) return "failed";
	return requested === "passed" && evidence.every(item => item.status === "passed") ? "passed" : "unverified";
}

/** Reconstructed from persisted tool records, before transcript pagination/truncation. */
export function buildAcceptanceReport(cells: readonly AgentCell[], streaming = false, requestedEvidenceIds: readonly string[] = []): AcceptanceReport {
	const users = cells.flatMap((cell, index) => cell.type === "user" ? [{ cell, index }] : []);
	const selected = users.slice(-8);
	const positions = new Map(cells.map((cell, index) => [cell.id, index]));
	const mutations = cells.flatMap((cell, index) => cell.type === "tool" && mayChange(cell) ? [{ cell, index }] : []);
	const turns = selected.map(({ cell: user, index }, turnIndex): AcceptanceTurn => {
		const end = users.find(entry => entry.index > index)?.index ?? cells.length;
		const tools = cells.slice(index + 1, end).filter((cell): cell is Tool => cell.type === "tool");
		const references = new Set([...requestedEvidenceIds, ...tools.flatMap(tool => {
			const ids = record(record(tool.details).acceptanceRecord).evidenceToolCallIds;
			return tool.toolName === "acceptance_check" && Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
		})]);
		const checks = tools.flatMap(tool => { const check = observedCheck(tool, references.has(tool.toolCallId)); return check ? [check] : []; });
		const active = streaming && turnIndex === selected.length - 1;
		if (!active) for (const check of checks) if (check.status === "running" || check.status === "pending") check.status = "unverified";
		const stale = (check: AcceptanceCheck) => {
			const position = positions.get(`tool-${check.toolCallId}`) ?? cells.findIndex(cell => cell.type === "tool" && cell.toolCallId === check.toolCallId);
			if ((check.status === "passed" || check.status === "failed") && mutations.some(mutation =>
				mutation.cell.toolCallId !== check.toolCallId && (mutation.cell.timestamp > check.startedAt || mutation.cell.timestamp === check.startedAt && mutation.index > position))) {
				check.previousStatus = check.status; check.status = "stale";
			}
		};
		checks.forEach(stale);
		const declarations = new Map<string, AcceptanceCheck>();
		for (const tool of tools) {
			if (tool.toolName !== "acceptance_check" || tool.status !== "done") continue;
			const declaration = record(record(tool.details).acceptanceRecord);
			if (typeof declaration.id !== "string" || typeof declaration.title !== "string") continue;
			const ids = Array.isArray(declaration.evidenceToolCallIds) ? declaration.evidenceToolCallIds.filter((id): id is string => typeof id === "string").slice(0, 12) : [];
			const evidence = ids.flatMap(id => checks.filter(check => check.toolCallId === id));
			const status = ids.length === evidence.length ? requirementStatus(text(declaration.status), evidence) : "unverified";
			declarations.set(declaration.id, {
				id: `requirement:${declaration.id}`, title: text(declaration.title), kind: "requirement", status, toolCallId: tool.toolCallId,
				evidenceToolCallIds: ids, reason: text(declaration.reason, 1000), output: "", outputTruncated: false,
				startedAt: evidence.length ? Math.min(...evidence.map(item => item.startedAt)) : tool.startedAt ?? tool.timestamp, finishedAt: tool.timestamp,
			});
		}
		const all = [...declarations.values(), ...checks];
		const changes = mutations.filter(mutation => mutation.index > index && mutation.index < end);
		return {
			id: user.id, title: user.text.slice(0, 400), timestamp: user.timestamp, checks: all.slice(-60), omittedChecks: Math.max(0, all.length - 60),
			changedPaths: [...new Set(changes.map(({ cell }) => text(record(cell.args).path, 240)).filter(Boolean))].slice(0, 16),
			possibleShellChanges: changes.some(({ cell }) => isShellTool(cell.toolName)), streaming: active,
		};
	});
	// The report travels with snapshots, including mobile relays with bounded frames.
	let remaining = 30;
	for (const turn of [...turns].reverse()) {
		const kept = remaining > 0 ? turn.checks.slice(-remaining) : [];
		turn.omittedChecks += turn.checks.length - kept.length;
		turn.checks = kept;
		remaining -= kept.length;
	}
	return { version: 1, turns, omittedTurns: Math.max(0, users.length - turns.length) };
}

export function acceptanceMarkdown(turn: AcceptanceTurn): string {
	return [`# ${turn.title.replace(/[\r\n]+/g, " ")}`, "", "Execution evidence only; passing checks do not prove every requirement is met.", "",
		...turn.checks.flatMap(check => [`## [${check.status}] ${check.title}`, ...(check.command ? [`Command: ${check.command}`] : []),
			...(check.exitCode !== undefined ? [`Exit code: ${check.exitCode}`] : []), ...(check.url ? [`URL: ${check.url}`] : []),
			...(check.viewport ? [`Viewport: ${check.viewport.width} × ${check.viewport.height}`] : []), `Evidence: ${check.evidenceToolCallIds.join(", ") || "none"}`,
			check.reason ?? "", check.output, ...(check.outputTruncated ? ["(Output excerpt; see original tool record for the complete output.)"] : []), ""]),
	].join("\n");
}
