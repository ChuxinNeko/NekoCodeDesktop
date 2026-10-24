import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../../src/shared/agent";
import { groupSessionsByWorkspace, mergeActiveSession, reconcileSessionRows, workspaceKey } from "../../src/shared/sessions";

function session(id: string, cwd: string): SessionSummary {
	return { id, sessionFile: `${id}.jsonl`, cwd, title: id, preview: "", updatedAt: 1, messageCount: 1 } as SessionSummary;
}

describe("groupSessionsByWorkspace", () => {
	test("stable sidebar order is unchanged by changing the current workspace or searching", () => {
		const rows = [session("first", "D:/a"), session("second", "D:/b"), session("third", "D:/a")];
		rows[2].updatedAt = 999;
		for (const currentCwd of ["D:/a", "D:/b"]) {
			const groups = groupSessionsByWorkspace(rows, { workspaces: ["D:/a", "D:/b"], currentCwd, preserveOrder: true });
			expect(groups.map((group) => group.cwd)).toEqual(["D:/a", "D:/b"]);
			expect(groups[0].sessions.map((row) => row.id)).toEqual(["first", "third"]);
		}
		expect(groupSessionsByWorkspace(rows, { query: "third", preserveOrder: true })[0].sessions.map((row) => row.id)).toEqual(["third"]);
	});
	test("leaves a removed workspace out, sessions and all, even when it is the current one", () => {
		const groups = groupSessionsByWorkspace([session("a", "D:\\Work\\Removed"), session("b", "D:\\Work\\Kept")], {
			workspaces: ["D:\\Work\\Removed", "D:\\Work\\Kept"],
			currentCwd: "D:\\Work\\Removed",
			hidden: [workspaceKey("d:/work/removed")],
		});
		expect(groups.map((group) => group.cwd)).toEqual(["D:\\Work\\Kept"]);
	});

	test("never hides the unassigned group", () => {
		const groups = groupSessionsByWorkspace([session("a", "")], { hidden: [""] });
		expect(groups.map((group) => group.sessions.length)).toEqual([1]);
	});
});

describe("stable sidebar session rows", () => {
	const rows = () => [
		{ ...session("newer", "D:/p"), updatedAt: 30 },
		{ ...session("middle", "D:/p"), updatedAt: 20 },
		{ ...session("older", "D:/p"), updatedAt: 10 },
	];
	test("opening a native session preserves its position, timestamp, and live title", () => {
		const previous = rows();
		const active = { ...previous[2], updatedAt: 9000, title: "Live title" };
		const merged = mergeActiveSession(previous, active);
		expect(merged[2]).toMatchObject({ title: "Live title", updatedAt: 10 });
		expect(reconcileSessionRows(previous, merged).map((row) => row.id)).toEqual(["newer", "middle", "older"]);
	});
	test("provider refreshes and streamed activity update data without promoting an existing row", () => {
		const previous = rows();
		const updated = { ...previous[2], updatedAt: 9999, running: true, title: "Changed" };
		const next = reconcileSessionRows(previous, [updated, previous[0], previous[1]]);
		expect(next.map((row) => row.id)).toEqual(["newer", "middle", "older"]);
		expect(next[2]).toBe(updated);
	});
	test("new sessions appear first, old history inserts by recency, and deletion removes only that row", () => {
		const previous = rows();
		const fresh = { ...session("fresh", "D:/p"), updatedAt: 40 };
		const history = { ...session("history", "D:/p"), updatedAt: 5 };
		const next = reconcileSessionRows(previous, [history, previous[2], fresh, previous[0]]);
		expect(next.map((row) => row.id)).toEqual(["fresh", "newer", "older", "history"]);
		expect(previous.map((row) => row.id)).toEqual(["newer", "middle", "older"]);
	});
	test("the first load remains newest first with deterministic ties", () => {
		const initial = rows().reverse();
		expect(reconcileSessionRows([], initial).map((row) => row.id)).toEqual(["newer", "middle", "older"]);
	});
});
