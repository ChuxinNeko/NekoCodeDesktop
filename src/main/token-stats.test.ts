import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayKey, totalTokens } from "../shared/tokenStats";
import { consumeLine, emptyScan, TokenStatsService } from "./token-stats";

const temporary: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-tokens-"));
	temporary.push(dir);
	return dir;
}

afterEach(() => {
	while (temporary.length) rmSync(temporary.pop() ?? "", { recursive: true, force: true });
});

const AT = "2026-09-19T14:30:00.000Z";

function assistant(
	usage: Record<string, unknown>,
	patch: { at?: string; provider?: string; model?: string } = {},
): string {
	return JSON.stringify({
		type: "message",
		timestamp: patch.at ?? AT,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			provider: patch.provider ?? "anthropic",
			model: patch.model ?? "claude-opus-4-8",
			usage,
		},
	});
}

const usage = (patch: Record<string, unknown> = {}) => ({
	input: 100,
	output: 50,
	cacheRead: 300,
	cacheWrite: 100,
	reasoning: 20,
	totalTokens: 550,
	cost: { total: 0.02 },
	...patch,
});

function transcript(dir: string, name: string, lines: string[]): string {
	const path = join(dir, name);
	writeFileSync(path, lines.map((line) => `${line}\n`).join(""), "utf8");
	return path;
}

const header = (cwd: string) =>
	JSON.stringify({ type: "session", id: "sess-1", timestamp: AT, cwd });

describe("consumeLine", () => {
	test("sums every assistant call into a day/provider/model bucket", () => {
		const scan = emptyScan();
		consumeLine(scan, header("/work/app"));
		consumeLine(scan, assistant(usage()));
		consumeLine(scan, assistant(usage({ input: 40 })));
		expect(scan.cwd).toBe("/work/app");
		expect(scan.counts).toMatchObject({ calls: 2, input: 140, output: 100, cacheRead: 600 });
		expect(scan.buckets.size).toBe(1);
		expect([...scan.buckets.values()][0]).toMatchObject({ calls: 2, cacheWrite: 200 });
	});

	test("keeps models apart on the same day", () => {
		const scan = emptyScan();
		consumeLine(scan, assistant(usage(), { model: "a" }));
		consumeLine(scan, assistant(usage(), { model: "b" }));
		expect(scan.buckets.size).toBe(2);
	});

	test("a call that reported no tokens is not counted as a free call", () => {
		const scan = emptyScan();
		consumeLine(
			scan,
			assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
		);
		expect(scan.counts.calls).toBe(0);
		expect(scan.buckets.size).toBe(0);
	});

	test("takes the title from the session name, else the opening prompt", () => {
		const named = emptyScan();
		consumeLine(named, JSON.stringify({ type: "session_info", name: "Ship the panel" }));
		expect(named.name).toBe("Ship the panel");

		const unnamed = emptyScan();
		consumeLine(
			unnamed,
			JSON.stringify({
				type: "message",
				timestamp: AT,
				message: { role: "user", content: [{ type: "text", text: "add token stats" }] },
			}),
		);
		expect(unnamed.firstMessage).toBe("add token stats");
	});

	test("a truncated or unknown line costs itself and nothing else", () => {
		const scan = emptyScan();
		consumeLine(scan, '{"type":"message","mess');
		consumeLine(scan, JSON.stringify({ type: "thinking_level_change", thinkingLevel: "off" }));
		consumeLine(scan, "");
		consumeLine(scan, assistant(usage()));
		expect(scan.counts.calls).toBe(1);
	});

	test("buckets by local day and hour, so evening work lands on today", () => {
		const scan = emptyScan();
		const at = new Date("2026-09-19T14:30:00.000Z");
		consumeLine(scan, assistant(usage(), { at: at.toISOString() }));
		const entry = [...scan.hours.values()][0];
		expect(entry.date).toBe(dayKey(at.getTime()));
		expect(entry.hour).toBe(at.getHours());
		expect(entry.tokens).toBe(550);
	});
});

describe("TokenStatsService", () => {
	test("rolls every transcript in the directory into one report", async () => {
		const dir = workspace();
		transcript(dir, "a.jsonl", [header("/work/app"), assistant(usage())]);
		transcript(dir, "b.jsonl", [
			header("/work/other"),
			assistant(usage({ input: 1000 }), { model: "glm-5.3" }),
		]);
		transcript(dir, "notes.txt", ["ignored"]);

		const report = await new TokenStatsService({ sessionDir: dir }).report();
		expect(report.files).toEqual({ scanned: 2, failed: 0 });
		expect(report.buckets).toHaveLength(2);
		expect(report.buckets.reduce((sum, entry) => sum + totalTokens(entry), 0)).toBe(2000);
		expect(new Set(report.sessions.map((entry) => entry.cwd))).toEqual(
			new Set(["/work/app", "/work/other"]),
		);
	});

	test("scheduled runs count too, and are labelled as such", async () => {
		const sessionDir = workspace();
		const automationDir = workspace();
		transcript(sessionDir, "a.jsonl", [header("/work/app"), assistant(usage())]);
		transcript(automationDir, "b.jsonl", [header("/work/app"), assistant(usage())]);

		const report = await new TokenStatsService({ sessionDir, automationDir }).report();
		expect(report.sessions.map((entry) => entry.kind).sort()).toEqual([
			"automation",
			"session",
		]);
	});

	test("re-reads only what was appended since the last report", async () => {
		const dir = workspace();
		const path = transcript(dir, "a.jsonl", [header("/work/app"), assistant(usage())]);
		const service = new TokenStatsService({ sessionDir: dir });

		const first = await service.report();
		expect(first.sessions[0].calls).toBe(1);

		appendFileSync(path, `${assistant(usage())}\n`, "utf8");
		const second = await service.report();
		// Counted twice would mean the first pass was replayed; counted once would
		// mean the append was missed. Two calls is the only correct answer.
		expect(second.sessions[0].calls).toBe(2);
		expect(second.sessions[0].input).toBe(200);
	});

	test("ignores a record that is still being written", async () => {
		const dir = workspace();
		const path = join(dir, "a.jsonl");
		writeFileSync(path, `${header("/work/app")}\n${assistant(usage())}\n`, "utf8");
		// A half-written line, exactly as a live transcript looks mid-append.
		appendFileSync(path, '{"type":"message","timestamp":"2026', "utf8");

		const service = new TokenStatsService({ sessionDir: dir });
		expect((await service.report()).sessions[0].calls).toBe(1);

		appendFileSync(path, `-09-19T15:00:00.000Z"}\n${assistant(usage())}\n`, "utf8");
		// The completed line is picked up on the next pass — the partial read did
		// not consume its first half.
		expect((await service.report()).sessions[0].calls).toBe(2);
	});

	test("a deleted session takes its tokens with it", async () => {
		const dir = workspace();
		const path = transcript(dir, "a.jsonl", [header("/work/app"), assistant(usage())]);
		transcript(dir, "b.jsonl", [header("/work/app"), assistant(usage())]);
		const service = new TokenStatsService({ sessionDir: dir });
		expect((await service.report()).buckets).toHaveLength(2);

		rmSync(path);
		const after = await service.report();
		expect(after.files.scanned).toBe(1);
		expect(after.buckets).toHaveLength(1);
	});

	test("a transcript rewritten shorter is parsed again from the top", async () => {
		const dir = workspace();
		const path = transcript(dir, "a.jsonl", [
			header("/work/app"),
			assistant(usage()),
			assistant(usage()),
		]);
		const service = new TokenStatsService({ sessionDir: dir });
		expect((await service.report()).sessions[0].calls).toBe(2);

		transcript(dir, "a.jsonl", [header("/work/app"), assistant(usage())]);
		expect((await service.report()).sessions[0].calls).toBe(1);
		expect(path).toContain("a.jsonl");
	});

	test("a missing directory reports nothing rather than failing", async () => {
		const report = await new TokenStatsService({
			sessionDir: join(workspace(), "not-here"),
		}).report();
		expect(report.buckets).toEqual([]);
		expect(report.files).toEqual({ scanned: 0, failed: 0 });
	});

	test("carries the provider labels the endpoints were saved under", async () => {
		const dir = workspace();
		transcript(dir, "a.jsonl", [header("/work/app"), assistant(usage(), { provider: "nekocode-1" })]);
		const report = await new TokenStatsService({
			sessionDir: dir,
			providerLabels: () => ({ "nekocode-1": "Z.ai" }),
		}).report();
		expect(report.providerLabels["nekocode-1"]).toBe("Z.ai");
	});
});
