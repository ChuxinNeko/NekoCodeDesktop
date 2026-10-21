import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpUsageStore } from "../../../src/main/acp/usage-store";
import { TokenStatsService } from "../../../src/main/token-stats";
import type { AcpSessionSummary } from "../../../src/shared/acp";
import { breakdown, dayKey, sumCounts, totalTokens } from "../../../src/shared/tokenStats";

test("ACP usage joins the report and survives reopen, incremental refresh, rescan and restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "acp-usage-"));
	try {
		const acpUsageDir = join(root, "acp");
		const options = { sessionDir: join(root, "sessions"), acpUsageDir };
		const service = new TokenStatsService(options);
		const store = new AcpUsageStore(acpUsageDir);
		const session: AcpSessionSummary = {
			id: "local-1", agentId: "codex", agentSessionId: "unsafe/../session", agentName: "Codex",
			cwd: "/project", title: "First title", status: "ready", pristine: false, createdAt: 1, updatedAt: 2,
		};
		const usage = { provider: "Codex", model: "gpt-test", calls: 1, input: 10, output: 5,
			cacheRead: 20, cacheWrite: 3, reasoning: 2, totalTokens: 38 };
		const at = new Date(2026, 9, 21, 10).getTime();
		expect((await service.report()).sessions).toHaveLength(0);
		store.record(session, usage, at);
		const first = await service.report();
		expect(first.sessions).toHaveLength(1);
		expect(first.sessions[0]).toMatchObject({ title: "First title", cwd: "/project", calls: 1, kind: "acp" });
		expect(first.buckets[0]).toMatchObject({ date: dayKey(at), provider: "Codex", model: "gpt-test", input: 10, cacheRead: 20, reasoning: 2, source: "acp" });
		// Identical provider/model names must not give direct API usage an ACP badge.
		const acp = first.buckets[0];
		const direct = { ...acp, source: undefined };
		const rows = breakdown([acp, direct], (bucket) => ({ key: bucket.model, label: bucket.model }));
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.source === "acp")?.total).toBe(38);
		expect(rows.find((row) => !row.source)?.total).toBe(38);
		expect(rows.reduce((sum, row) => sum + row.share, 0)).toBe(1);
		expect(first.hours[0]).toMatchObject({ hour: 10, tokens: 38 });
		expect((await service.report()).buckets).toEqual(first.buckets);

		// A reopened conversation has a fresh local id, but remains one ledger.
		store.record({ ...session, id: "local-2", title: "Renamed" }, usage, at + 3600000);
		// Agent-owned session ids may also collide across different agents.
		store.record({ ...session, agentId: "custom", agentName: "Custom" }, { ...usage, provider: "Custom" }, at);
		const report = await service.report();
		expect(report.sessions).toHaveLength(2);
		expect(report.sessions.find((entry) => entry.title === "Renamed")).toMatchObject({ calls: 2 });
		expect(totalTokens(sumCounts(report.buckets))).toBe(114);
		expect(sumCounts(report.buckets).calls).toBe(3);
		service.reset();
		expect((await service.report()).buckets).toEqual(report.buckets);
		expect((await new TokenStatsService(options).report()).sessions).toEqual(report.sessions);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
