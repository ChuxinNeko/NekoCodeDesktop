import { expect, test } from "bun:test";
import { frontendFiles } from "../../../src/shared/frontend-preview";
import { completedTurnChanges } from "../../../src/renderer/src/lib/turnChanges";
import { groupTranscriptRows } from "../../../src/shared/transcript";
import type { AgentCell } from "../../../src/shared/agent";
import type { CheckpointSummary } from "../../../src/shared/checkpoints";

test("frontend detection excludes backend work, tests, and generated dependencies", () => {
	const frontend = ["index.html", "src/App.tsx", "src/components/Clock.ts", "site/style.css", "pages/home.vue", "web/main.js", "src\\views\\index.svelte"];
	expect(frontendFiles([...frontend, "README.md", "src/server.ts", "api/server.js", "src/App.test.tsx", "tests/form.tsx", "node_modules/lib/a.css", "dist/index.html"])).toEqual(frontend);
});

test("only the answer closing an edited frontend turn receives its own checkpoint", () => {
	const checkpoint: CheckpointSummary = { id: "checkpoint", sessionId: "session", createdAt: 1, label: "Build app", cellId: "prompt", conversationRestorable: true, codeRestorable: true, fileCount: 1, files: [{ path: "src/App.tsx", additions: 4, deletions: 0 }], additions: 4, deletions: 0, shellRuns: 0 };
	const user = (id: string): AgentCell => ({ id, type: "user", text: id, timestamp: 1 });
	const answer: AgentCell = { id: "answer", type: "assistant", text: "Built", thinking: "", streaming: false, timestamp: 2 };
	const cells = [user("prompt"), answer];
	expect(completedTurnChanges(groupTranscriptRows(cells), [checkpoint], true).size).toBe(0);
	const completed = completedTurnChanges(groupTranscriptRows([...cells, user("question"), { ...answer, id: "plain-answer" }]), [checkpoint], false);
	expect([...completed.keys()]).toEqual(["answer-message"]);
	expect(frontendFiles(completed.get("answer-message")!.files.map(file => file.path))).toEqual(["src/App.tsx"]);
	expect(completed.has("plain-answer-message")).toBe(false);
});
