import type { ParseResult } from "@openuidev/react-lang";

/** A write tool cannot be smuggled into an automatically executed Query. */
export function openuiProgramAllowsWrite(program: ParseResult, tool: string): boolean {
	if (program.meta.incomplete) return false;
	if (program.queryStatements.some(query => query.toolAST?.k !== "Str" || query.toolAST.v === tool)) return false;
	return program.mutationStatements.some(mutation => mutation.toolAST?.k === "Str" && mutation.toolAST.v === tool);
}
