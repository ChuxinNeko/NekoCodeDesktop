import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CHECKPOINT_ENTRY, fileMutation, planReversal, reportPreimage, turnStats, unpackPreimage } from "../../src/main/file-journal";
import { applyReversal } from "../../src/main/file-restore";
import { WorkflowRuntime } from "../../src/main/workflow-runtime";

const lead = { provider: "anthropic", id: "lead" } as Model<Api>;
const side = { provider: "zai", id: "side" } as Model<Api>;

describe("worker checkpoint journal", () => {
	for (const fusion of [false, true]) for (const failed of [false, true]) {
		test(`${fusion ? "Fusion" : "ordinary"} worker edits survive ${failed ? "failure" : "reuse"} and can be restored`, async () => {
			const cwd = mkdtempSync(join(tmpdir(), "nekocode-worker-checkpoint-"));
			const manager = pi.SessionManager.inMemory(cwd);
			const childManager = pi.SessionManager.inMemory(cwd);
			let runtime: WorkflowRuntime | undefined;
			let createCount = 0;
			let run = 0;
			let checkpointId = "";
			const visibleChanges: Array<ReturnType<typeof turnStats>> = [];
			const child: any = {
				model: fusion ? side : lead, sessionId: "checkpoint-worker", agent: {}, messages: [],
				sessionManager: childManager,
				setActiveToolsByName: () => undefined, subscribe: () => () => undefined,
				abort: async () => undefined, dispose: () => undefined,
				prompt: async () => {
					run++;
					const invoke = async (name: string, path: string, change: () => void, isError = false) => {
						const previousCount = manager.getBranch().filter((entry) => fileMutation(entry)).length;
						const context = { toolCall: { id: `${run}-${name}-${path}`, name }, args: { path } };
						const result = await child.agent.beforeToolCall(context);
						expect(result?.block, result?.reason).not.toBe(true);
						change();
						await child.agent.afterToolCall?.({ ...context, isError });
						// The parent UI must be notified before the worker continues or returns.
						const mutationCount = manager.getBranch().filter((entry) => fileMutation(entry)).length;
						if (mutationCount > previousCount) {
							expect(visibleChanges.at(-1)).toEqual(turnStats(manager.getBranch(), checkpointId));
							expect(visibleChanges.at(-1)?.list.some((file) => file.path === (name === "ast_edit" ? "ast.ts" : path))).toBe(true);
						}
						return result;
					};
					await invoke("edit", "existing.ts", () => writeFileSync(join(cwd, "existing.ts"), `edited ${run}\n`));
					await invoke("write", "created.ts", () => writeFileSync(join(cwd, "created.ts"), `created ${run}\n`));
					// Multi-file tools commit their reported writes even if a later file fails.
					await invoke("ast_edit", ".", () => {
						const path = join(cwd, "ast.ts");
						const before = readFileSync(path);
						writeFileSync(path, `ast ${run}\n`);
						reportPreimage(`${run}-ast_edit-.`, { tool: "ast_edit", path, before });
					}, true);
					await invoke("edit", "failed.ts", () => undefined, true);
					await expect(invoke("write", "../outside.ts", () => { throw new Error("Blocked write ran"); }))
						.rejects.toThrow("Path is outside the workspace");
					if (failed) throw new Error("helper failed after edits");
					child.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }];
				},
			};
			const spy = spyOn(pi, "createAgentSession").mockImplementation(async () => {
				createCount++;
				return { session: child } as any;
			});
			try {
				for (const path of ["existing.ts", "ast.ts", "failed.ts"]) writeFileSync(join(cwd, path), "original\n");
				manager.appendCustomEntry(CHECKPOINT_ENTRY, { label: "worker task" });
				const checkpoint = manager.getLeafId()!;
				checkpointId = checkpoint;
				runtime = new WorkflowRuntime({
					cwd, agentDir: join(cwd, ".agent"), debugRoot: cwd,
					initialMode: "multitask", initialFusion: fusion ? {
						leadModelKey: "anthropic/lead", leadThinkingLevel: "high",
						sidekickModelKey: "zai/side", sidekickThinkingLevel: "medium",
					} : null,
					sessionManager: manager, getPermission: () => "auto",
					modelRuntime: { getAvailableSnapshot: () => [lead, side] } as any,
					onChange: () => visibleChanges.push(turnStats(manager.getBranch(), checkpointId)), onModeChange: () => undefined,
				});
				runtime.attach({ agent: {}, model: lead, messages: [], sessionManager: manager,
					setActiveToolsByName: () => undefined, subscribe: () => () => undefined } as unknown as AgentSession);
				const harness = runtime as unknown as {
					runHelper: (role: string, prompt: string, signal: undefined, scopes: string[], onStep: undefined,
						options: { reuseFusionWorker: boolean }) => Promise<string>;
				};
				for (let i = 0; i < 2; i++) {
					const result = harness.runHelper("agent", "Edit files", undefined, [cwd], undefined, { reuseFusionWorker: fusion });
					if (failed) await expect(result).rejects.toThrow("helper failed after edits");
					else await result;
				}
				const mutations = manager.getBranch().flatMap((entry) => fileMutation(entry) ?? []);
				expect(visibleChanges.at(-1)?.list.map((file) => file.path)).toEqual(["existing.ts", "created.ts", "ast.ts"]);
				expect(visibleChanges.at(-1)?.additions).toBe(mutations.reduce((total, mutation) => total + (mutation.additions ?? 0), 0));
				expect(visibleChanges.at(-1)?.deletions).toBe(mutations.reduce((total, mutation) => total + (mutation.deletions ?? 0), 0));
				expect(mutations.map((entry) => entry.path)).toEqual([
					"existing.ts", "created.ts", "ast.ts", "existing.ts", "created.ts", "ast.ts",
				]);
				expect(mutations[0].additions).toBe(1);
				expect(mutations[0].deletions).toBe(1);
				expect(unpackPreimage(mutations[0].before!).toString()).toBe("original\n");
				expect(childManager.getBranch().flatMap((entry) => fileMutation(entry) ?? [])).toEqual([]);
				expect(createCount).toBe(fusion && !failed ? 1 : 2);
				const plan = planReversal(manager.getBranch(), checkpoint);
				expect(plan.steps.map((step) => step.path)).toEqual(["ast.ts", "created.ts", "existing.ts"]);
				await applyReversal(plan, cwd);
				expect(readFileSync(join(cwd, "existing.ts"), "utf8")).toBe("original\n");
				expect(readFileSync(join(cwd, "ast.ts"), "utf8")).toBe("original\n");
				expect(existsSync(join(cwd, "created.ts"))).toBe(false);
			} finally {
				spy.mockRestore();
				runtime?.dispose();
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	}
});
