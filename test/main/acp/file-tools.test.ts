import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createAcpFileTools } from "../../../src/main/acp/file-tools";
import { McpToolServer } from "../../../src/main/mcp/tool-server";

const directories: string[] = [];
const servers: McpToolServer[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function workspace() {
	const cwd = mkdtempSync(join(tmpdir(), "neko-acp-file-tools-"));
	directories.push(cwd);
	writeFileSync(join(cwd, "中文 example.ts"), "one\ntwo\nthree\nfour");
	writeFileSync(join(cwd, "notebook.ipynb"), JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# Notebook heading"] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
	const server = new McpToolServer({
		version: "test",
		validate: (tool, args) => validateToolArguments(tool as never, { type: "toolCall", id: "test", name: tool.name, arguments: args } as never),
	});
	servers.push(server);
	const handle = await server.register({ tools: () => createAcpFileTools(pi, cwd) });
	return {
		cwd,
		read: async (args: Record<string, unknown>) => {
			const response = await fetch(handle.url, {
				method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(handle.headers.map(({ name, value }) => [name, value])) },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: args } }),
			});
			expect(response.status).toBe(200);
			return (await response.json() as { result: { content: { text: string }[]; isError?: boolean } }).result;
		},
	};
}

test("ACP read accepts line selectors on the first MCP call, including Windows absolute paths", async () => {
	const { cwd, read } = await workspace();
	for (const path of ["中文 example.ts:2-3", `${join(cwd, "中文 example.ts")}:2-3`]) {
		const result = await read({ path });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toStartWith("two\nthree\n\n[");
		expect(result.content[0].text).toContain("offset=4");
	}
});

test("ACP read renders notebooks instead of exposing their container JSON", async () => {
	const { read } = await workspace();
	const result = await read({ path: "notebook.ipynb" });
	expect(result.isError).not.toBe(true);
	expect(result.content[0].text).toContain("# Notebook heading");
	expect(result.content[0].text).not.toContain('"cell_type"');
});

test("nullable optional arguments and a failed read do not poison subsequent calls", async () => {
	const { read } = await workspace();
	expect((await read({ path: "missing.ts" })).isError).toBe(true);
	const result = await read({ path: "中文 example.ts", offset: null, limit: null });
	expect(result.isError).not.toBe(true);
	expect(result.content[0].text).toBe("one\ntwo\nthree\nfour");
});
