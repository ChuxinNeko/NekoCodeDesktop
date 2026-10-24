import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM } from "../../src/shared/team";
import { TeamWorkspaceStore } from "../../src/main/team-workspace-store";
import { TeamMessages } from "../../src/main/fusion/team-messages";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("each streamed message keeps its identity and remains saved across delegation and reload", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-messages-")); directories.push(dir);
	const store = new TeamWorkspaceStore(dir);
	const chief = DEFAULT_TEAM.members[0];
	const messages = new TeamMessages(store, "group", chief, "chief-work");
	messages.delta("I will ");
	const first = store.snapshot().posts[0];
	messages.delta("introduce myself.");
	expect(store.snapshot().posts[0]).toMatchObject({ id: first.id, text: "I will introduce myself.", status: "streaming" });
	messages.message("I will introduce myself.");
	store.post({ roomId: "group", memberId: "chief", name: "Chief", kind: "assignment", text: "@Coder write HTML" });
	store.post({ roomId: "group", memberId: "chief", name: "Chief", kind: "assignment", text: "@Reviewer review HTML" });
	const worker = new TeamMessages(store, "group", DEFAULT_TEAM.members[1], "coder-work");
	worker.message("HTML is ready."); worker.finish("HTML is ready.");
	messages.delta("All done."); messages.message("All done."); messages.finish("All done.");
	const restored = new TeamWorkspaceStore(dir).snapshot().posts;
	expect(restored.map(post => post.text)).toEqual(["I will introduce myself.", "@Coder write HTML", "@Reviewer review HTML", "HTML is ready.", "All done."]);
	expect(restored[0].id).toBe(first.id);
	expect(new Set(restored.map(post => post.id)).size).toBe(5);
});

test("stopping a streamed reply preserves its partial text; reload marks interrupted streams", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-messages-stop-")); directories.push(dir);
	const store = new TeamWorkspaceStore(dir);
	const messages = new TeamMessages(store, "group", DEFAULT_TEAM.members[0], "work");
	messages.message("Opening reply.");
	messages.delta("Partial response");
	expect(new TeamWorkspaceStore(dir).snapshot().posts[1]).toMatchObject({ text: "Partial response", status: "failed" });
	messages.fail();
	expect(store.snapshot().posts.map(post => [post.text, post.status])).toEqual([["Opening reply.", "done"], ["Partial response", "failed"]]);
});
