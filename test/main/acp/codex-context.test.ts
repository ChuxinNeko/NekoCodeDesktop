import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexContextReader, codexContextHome } from "../../../src/main/acp/codex-context";
import { AcpSession } from "../../../src/main/acp/session";
import { BUILTIN_ACP_AGENTS } from "../../../src/main/acp/agents";
import type { AcpTransport } from "../../../src/main/acp/connection";

const ID = "12345678-1234-1234-1234-123456789abc";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const entry = (type: string, payload: object) => `${JSON.stringify({ type, payload })}\n`;
const message = (role: string, text: string) => entry("response_item", { type: "message", role, content: [{ type: "input_text", text }] });
function fixture(id = ID) {
	const home = mkdtempSync(join(tmpdir(), "nekocode-context-"));
	directories.push(home);
	const directory = join(home, "sessions", "2026", "10", "24");
	mkdirSync(directory, { recursive: true });
	const file = join(directory, `rollout-2026-10-24T12-32-50-${ID}.jsonl`);
	writeFileSync(file, entry("session_meta", { id, base_instructions: { text: "system prompt" } }) +
		message("developer", "rules\n<skills_instructions>skill catalog</skills_instructions><multi_agent_role>agent contract</multi_agent_role>") + message("user", "hello"));
	return { file, reader: new CodexContextReader(home, ID), home };
}

describe("Codex ACP local context", () => {
	test("session startup and prompt completion publish Codex categories through the real snapshot path", async () => {
		const { home, file } = fixture();
		appendFileSync(file, entry("event_msg", { type: "token_count", info: { last_token_usage: { total_tokens: 1000 }, model_context_window: 10000 } }));
		let receive: (message: unknown) => void = () => {};
		const transport: AcpTransport = {
			onMessage: (listener) => { receive = listener; }, onClose: () => {}, close: () => {},
			send: async (raw) => {
				const request = raw as { id: number; method: string };
				queueMicrotask(() => {
					if (request.method === "session/prompt") {
						appendFileSync(file, message("assistant", "a new reply"));
						receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ID, update: { sessionUpdate: "usage_update", used: 2000, size: 10000 } } });
					}
					const result = request.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} }
						: request.method === "session/new" ? { sessionId: ID } : { stopReason: "end_turn" };
					receive({ jsonrpc: "2.0", id: request.id, result });
				});
			},
		};
		const session = new AcpSession({ id: "local", cwd: home, agent: { ...BUILTIN_ACP_AGENTS.find((agent) => agent.id === "codex")!, env: { CODEX_HOME: home } }, clientVersion: "test", createTransport: () => transport, onChange: () => {} });
		try {
			await session.start();
			expect(session.snapshot().context).toMatchObject({ used: 1000, source: "acp", breakdownSource: "codex-rollout" });
			const before = session.snapshot().context!.breakdown!.conversation!;
			await session.prompt("test");
			expect(session.snapshot().context).toMatchObject({ used: 2000, source: "acp", breakdownSource: "codex-rollout" });
			expect(session.snapshot().context!.breakdown!.conversation).toBeGreaterThan(before);
		} finally { session.dispose(); }
	});
	test("fills observable categories from the matching rollout and preserves ACP totals", async () => {
		const { reader } = fixture();
		const result = (await reader.read({ used: 27300, window: 1000000 }))!;
		expect(result.used).toBe(27300);
		expect(result.source).toBe("acp");
		expect(result.breakdownSource).toBe("codex-rollout");
		for (const key of ["system", "rules", "skills", "subagents", "conversation"] as const) expect(result.breakdown?.[key]).toBeGreaterThan(0);
		expect(result.breakdown?.tools).toBeUndefined();
		expect(result.breakdown?.mcp).toBeUndefined();
	});

	test("incremental reads do not double-count, tolerate incomplete final lines, and retain UTF-8", async () => {
		const { reader, file } = fixture();
		const reported = { used: 1000, window: 10000 };
		const before = (await reader.read(reported))!;
		expect(await reader.read(reported)).toEqual(before);
		const next = Buffer.from(message("user", "测试中文"));
		const split = next.indexOf(Buffer.from("中")) + 1;
		appendFileSync(file, next.subarray(0, split));
		expect(await reader.read(reported)).toEqual(before);
		appendFileSync(file, next.subarray(split));
		const after = (await reader.read(reported))!;
		expect(after.breakdown!.conversation).toBe(before.breakdown!.conversation! + 4);
	});

	test("restores total usage for resumed sessions without an ACP replayed usage event", async () => {
		const { reader, file } = fixture();
		appendFileSync(file, entry("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 99999 }, last_token_usage: { total_tokens: 1200 }, model_context_window: 10000 } }));
		expect(await reader.read()).toMatchObject({ used: 1200, window: 10000 });
	});

	test("compaction replaces conversation instead of accumulating all historical messages", async () => {
		const { reader, file } = fixture();
		appendFileSync(file, message("assistant", "x".repeat(4000)));
		await reader.read({ used: 2000, window: 10000 });
		appendFileSync(file, entry("compacted", { message: "summary" }));
		expect((await reader.read({ used: 100, window: 10000 }))?.breakdown?.conversation).toBe(2);
	});

	test("does not read a different session, malformed IDs, or missing history", async () => {
		const { reader, home } = fixture("different-session");
		expect(await reader.read({ used: 100, window: 10000 })).toBeUndefined();
		expect(await new CodexContextReader(home, "../../bad").read()).toBeUndefined();
		expect(await new CodexContextReader(join(home, "missing"), ID).read()).toBeUndefined();
	});

	test("reconciles estimates to small totals and recognizes case-insensitive custom CODEX_HOME", async () => {
		const { reader, home } = fixture();
		const result = (await reader.read({ used: 1, window: 10000 }))!;
		expect(Object.values(result.breakdown!).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(1);
		expect(codexContextHome({ Codex_Home: home })).toBe(home);
	});
});
