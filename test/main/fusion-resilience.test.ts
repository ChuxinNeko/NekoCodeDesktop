import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { FusionProgressGuard, FusionRequestDeadline, fusionFileFingerprint, isFusionContinuation } from "../../src/main/fusion-resilience";

const frame = (failed = false) => ({ message: { ...fauxAssistantMessage(""), content: [
	{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "source.ts" } },
] }, toolResults: [{ role: "toolResult" as const, toolCallId: "read", toolName: "read", content: [{ type: "text" as const, text: "result" }], isError: failed, timestamp: 1 }] });

describe("Fusion task resilience", () => {
	test("repeated failed calls and repeated evidence are bounded even if the model ignores tool restrictions", () => {
		const failed = new FusionProgressGuard();
		expect(failed.finish(frame(true))).toBeUndefined(); expect(failed.finish(frame(true))).toBeUndefined();
		expect(failed.finish(frame(true))).toContain("three consecutive failed");
		const repeated = new FusionProgressGuard();
		for (let i = 0; i < 7; i++) { repeated.evidence("read", "source.ts", "same contents"); const result = repeated.finish(frame());
			if (i === 6) expect(result).toContain("six tool turns"); else expect(result).toBeUndefined(); }
	});
	test("same-content and oscillating writes cannot reset handoff exhaustion", () => {
		const guard = new FusionProgressGuard();
		expect(guard.write("a.md", "absent", "a")).toBe(true);
		expect(guard.write("a.md", "a", "a")).toBe(false);
		expect(guard.write("a.md", "a", "b")).toBe(true);
		expect(guard.write("a.md", "b", "a")).toBe(false);
		for (let i = 0; i < 6; i++) expect(guard.handoff()).toBeUndefined();
		expect(guard.handoff()).toContain("six consecutive handoffs");
	});
	test("request and usage counters survive validated restoration and human continuation", () => {
		const guard = new FusionProgressGuard(); guard.request(); guard.usage(123);
		const restored = new FusionProgressGuard(); expect(restored.restore(guard.snapshot())).toBe(true); restored.resume();
		expect(restored.snapshot().requests).toBe(1); expect(restored.snapshot().tokens).toBe(123);
		for (let i = 1; i < 160; i++) expect(restored.request()).toBeUndefined();
		expect(restored.request()).toContain("160-request");
		expect(restored.restore({ ...guard.snapshot(), seen: ["invalid"] })).toBe(false);
	});
	test("hashing checks actual file bytes without changing files", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "fusion-hash-"));
		try { const path = join(cwd, "a.md"); expect(await fusionFileFingerprint(path)).toBe("absent");
			await writeFile(path, "a"); const first = await fusionFileFingerprint(path);
			await writeFile(path, "a"); expect(await fusionFileFingerprint(path)).toBe(first);
			await writeFile(path, "b"); expect(await fusionFileFingerprint(path)).not.toBe(first);
		} finally { await rm(cwd, { recursive: true, force: true }); }
	});
	test("provider deadline fires once and can be cleared before tool execution", async () => {
		let expired = 0; const deadline = new FusionRequestDeadline(() => expired++, 5);
		deadline.start(); deadline.clear(); await new Promise((resolve) => setTimeout(resolve, 15)); expect(expired).toBe(0);
		deadline.start(); await new Promise((resolve) => setTimeout(resolve, 15)); expect(expired).toBe(1); deadline.clear();
	});
	test("continuation recognition is explicit and short", () => {
		for (const text of ["继续", "继续，保留已有文件", "Resume with the observed error"]) expect(isFusionContinuation(text)).toBe(true);
		expect(isFusionContinuation("Implement a different feature")).toBe(false);
	});
});
