import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiCodingAgentModule } from "../pi";
import { createReadTool } from "../read-tool";

/** ACP receives the same file syntax and document readers as NekoLocal. */
export function createAcpFileTools(pi: PiCodingAgentModule, cwd: string): ToolDefinition<any, any>[] {
	return [
		createReadTool(pi, cwd),
		pi.createGrepToolDefinition(cwd),
		pi.createFindToolDefinition(cwd),
		pi.createLsToolDefinition(cwd),
	];
}
