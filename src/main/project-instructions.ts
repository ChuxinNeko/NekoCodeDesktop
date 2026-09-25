import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	INIT_EXTRA_LABEL,
	INIT_PROMPT_MARKER,
	INSTRUCTION_FILE_NAMES,
	MAX_INSTRUCTIONS_BYTES,
	type InstructionFile,
	type ProjectInstructions,
	type SaveInstructionsRequest,
} from "../shared/instructions";
import { pi } from "./pi";
import { checkoutRoot, projectKey, projectRoot } from "./project-root";

/**
 * The file the core would load from `dir`, or where a new one belongs.
 *
 * Editing has to land on the file that is actually read: if a project keeps
 * CLAUDE.md, writing a fresh AGENTS.md beside it would silently replace what
 * the agent sees, because AGENTS.md comes first in the core's search order.
 */
export function instructionTarget(dir: string): string {
	for (const name of INSTRUCTION_FILE_NAMES) {
		const path = join(dir, name);
		try {
			if (statSync(path).isFile()) return path;
		} catch {
			// Not this one.
		}
	}
	return join(dir, "AGENTS.md");
}

/** Everything the core feeds a session in `cwd`, and where edits go. */
export async function readProjectInstructions(cwd: string): Promise<ProjectInstructions> {
	const { loadProjectContextFiles, getAgentDir } = await pi();
	const agentDir = getAgentDir();
	const globalPath = instructionTarget(agentDir);
	const root = checkoutRoot(cwd);
	const projectPath = instructionTarget(root);
	const loaded: InstructionFile[] = loadProjectContextFiles({ cwd, agentDir }).map((file) => ({
		path: file.path,
		content: file.content,
		scope:
			projectKey(file.path) === projectKey(globalPath)
				? "global"
				: projectKey(dirname(file.path)) === projectKey(root) || projectKey(dirname(file.path)) === projectKey(cwd)
					? "project"
					: "ancestor",
	}));
	return { cwd: resolve(cwd), loaded, globalPath, projectPath, projectRoot: projectRoot(cwd) };
}

/**
 * Write the global or the project file.
 *
 * Only ever one of the two paths {@link readProjectInstructions} names: the
 * renderer says which scope, never which path, so nothing it sends can steer a
 * write anywhere else on disk.
 */
export async function saveProjectInstructions(request: SaveInstructionsRequest): Promise<ProjectInstructions> {
	if (typeof request.content !== "string") throw new Error("内容无效");
	if (Buffer.byteLength(request.content, "utf8") > MAX_INSTRUCTIONS_BYTES)
		throw new Error(`指令文件不能超过 ${MAX_INSTRUCTIONS_BYTES / 1024} KB`);
	if (!request.cwd || !existsSync(request.cwd)) throw new Error("项目目录不存在");
	const current = await readProjectInstructions(request.cwd);
	const target = request.scope === "global" ? current.globalPath : request.scope === "project" ? current.projectPath : null;
	if (!target) throw new Error("未知的指令范围");
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.nekocode-tmp`;
	writeFileSync(temporary, request.content.replace(/\r\n/g, "\n"), "utf8");
	renameSync(temporary, target);
	return readProjectInstructions(request.cwd);
}

/**
 * What `/init` asks the agent to do.
 *
 * Written as a prompt rather than generated here: knowing what is worth
 * writing down about a codebase takes reading it, and that is the agent's job.
 */
export function initPrompt(cwd: string, extra: string): string {
	const target = instructionTarget(checkoutRoot(cwd));
	const exists = existsSync(target);
	return [
		INIT_PROMPT_MARKER,
		exists
			? `请阅读并改进项目指令文件 \`${target}\`，让它更准确、更有用。`
			: `请为这个项目创建项目指令文件 \`${target}\`。`,
		"",
		"这个文件会在之后每个会话开始时注入系统提示，读者是将来在这个仓库工作的编码 agent。先实际探索仓库（目录结构、包管理与脚本、构建/测试/lint 命令、主要模块、已有的 README 与贡献说明），再写。内容要求：",
		"- 常用命令：安装、开发、构建、测试（含运行单个测试的方法）、lint/格式化，写出可直接执行的命令。",
		"- 架构概览：需要读多个文件才能理解的整体结构与关键数据流，不要逐个罗列显而易见的文件。",
		"- 约定与陷阱：代码风格、命名、目录约定、不能改的地方、容易踩的坑——只写从代码里能确认的内容。",
		"- 简洁：不写泛泛的开发建议，不编造不存在的命令或规范，不重复 README 里一眼可见的内容。",
		exists ? "- 保留原文件中仍然正确的内容，修正过时的部分。" : "",
		"",
		"完成后用一两句话说明写了什么。",
		extra.trim() ? `\n${INIT_EXTRA_LABEL}${extra.trim()}` : "",
	]
		.filter((line, index, all) => line !== "" || all[index - 1] !== "")
		.join("\n");
}
