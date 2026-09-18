import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "./agent";
import {
	UNTITLED_SESSION,
	groupSessions,
	groupSessionsByWorkspace,
	workspaceKey,
	mergeActiveSession,
	normalizeLine,
	relativeSessionTime,
	sessionBucket,
	sessionMatchesQuery,
	sessionTitle,
} from "./sessions";

const NOW = new Date("2026-09-16T14:30:00").getTime();
const DAY = 86_400_000;

describe("workspace session grouping", () => {
	test("uses full paths, keeps same-name folders separate and sorts threads by recency", () => {
		const groups = groupSessionsByWorkspace([
			session({ id: "old", cwd: "D:\\one\\app", updatedAt: NOW - DAY }),
			session({ id: "other", cwd: "D:\\two\\app" }),
			session({ id: "new", cwd: "d:/one/app/" }),
		], { currentCwd: "D:\\one\\app" });
		expect(groups).toHaveLength(2);
		expect(groups[0]!.sessions.map((entry) => entry.id)).toEqual(["new", "old"]);
		expect(groups[1]!.sessions.map((entry) => entry.id)).toEqual(["other"]);
		expect(groups.map((group) => group.label)).toEqual(["app", "app"]);
	});
	test("includes remembered empty workspaces and the current folder", () => {
		const groups = groupSessionsByWorkspace([], { currentCwd: "/current", workspaces: ["/empty", "/empty/"] });
		expect(groups.map((group) => group.cwd)).toEqual(["/current", "/empty"]);
	});
	test("searches every workspace by title, preview or full path without mutating input", () => {
		const input = [session({ id: "first", cwd: "/one", title: "Fix login" }), session({ id: "second", cwd: "/two", preview: "LOGIN regression" })];
		expect(groupSessionsByWorkspace(input, { query: "login" })).toHaveLength(2);
		expect(groupSessionsByWorkspace(input, { query: "/two" })[0]!.sessions[0]!.id).toBe("second");
		expect(groupSessionsByWorkspace(input, { query: "absent" })).toEqual([]);
		expect(input.map((entry) => entry.id)).toEqual(["first", "second"]);
	});
	test("POSIX case stays distinct and Windows separators/case are normalized", () => {
		expect(workspaceKey("C:\\Work\\App\\")).toBe(workspaceKey("c:/work/app"));
		expect(workspaceKey("/Work/App")).not.toBe(workspaceKey("/work/app"));
		expect(workspaceKey("/")).toBe("/");
	});
});

function session(patch: Partial<SessionSummary> & { id: string }): SessionSummary {
	return {
		sessionFile: `/sessions/${patch.id}.jsonl`,
		cwd: "/repo",
		title: patch.id,
		titlePending: false,
		preview: "",
		createdAt: NOW,
		updatedAt: NOW,
		messageCount: 2,
		...patch,
	};
}

describe("normalizeLine", () => {
	test("collapses whitespace and trims", () => {
		expect(normalizeLine("  fix\n the\t build  ", 40)).toBe("fix the build");
	});

	test("clips with an ellipsis that fits inside the budget", () => {
		const clipped = normalizeLine("a".repeat(50), 10);
		expect(clipped).toBe(`${"a".repeat(9)}…`);
		expect(clipped.length).toBe(10);
	});
});

describe("sessionTitle", () => {
	test("prefers a user-set name", () => {
		expect(sessionTitle("  Release prep  ", "why is the build red")).toBe("Release prep");
	});

	test("falls back to the opening prompt, then to a placeholder", () => {
		expect(sessionTitle(null, "  why is the build red ")).toBe("why is the build red");
		expect(sessionTitle("   ", "")).toBe(UNTITLED_SESSION);
	});
});

describe("mergeActiveSession", () => {
	const listed = [session({ id: "a" }), session({ id: "b" })];

	test("adds the open session while its transcript is still unwritten", () => {
		const active = session({ id: "live", messageCount: 1, titlePending: true });
		const merged = mergeActiveSession(listed, active);
		expect(merged.map((s) => s.id)).toEqual(["live", "a", "b"]);
	});

	test("prefers the live copy of a session already on disk", () => {
		const active = session({ id: "a", title: "Named by the model", messageCount: 4 });
		const merged = mergeActiveSession(listed, active);
		expect(merged).toHaveLength(2);
		expect(merged[0]?.title).toBe("Named by the model");
	});

	test("leaves the list alone with no session, or one nothing has been sent to", () => {
		expect(mergeActiveSession(listed, null)).toEqual(listed);
		expect(mergeActiveSession(listed, session({ id: "empty", messageCount: 0 }))).toEqual(listed);
	});
});

describe("sessionBucket", () => {
	test("splits on calendar days, not rolling 24-hour windows", () => {
		const lateYesterday = new Date("2026-09-15T23:55:00").getTime();
		expect(sessionBucket(lateYesterday, NOW)).toBe("yesterday");
		// Only 40 minutes old, but it is already the next calendar day.
		expect(sessionBucket(new Date("2026-09-16T00:05:00").getTime(), NOW)).toBe("today");
	});

	test("walks out to the older bucket", () => {
		expect(sessionBucket(NOW - 3 * DAY, NOW)).toBe("week");
		expect(sessionBucket(NOW - 20 * DAY, NOW)).toBe("month");
		expect(sessionBucket(NOW - 400 * DAY, NOW)).toBe("older");
	});

	test("keeps a clock-skewed future timestamp at the top", () => {
		expect(sessionBucket(NOW + DAY, NOW)).toBe("today");
	});
});

describe("sessionMatchesQuery", () => {
	const target = session({ id: "a", title: "Fix the CI build", preview: "why is main red" });

	test("matches title and preview case-insensitively", () => {
		expect(sessionMatchesQuery(target, "ci BUILD")).toBe(true);
		expect(sessionMatchesQuery(target, "main red")).toBe(true);
		expect(sessionMatchesQuery(target, "deploy")).toBe(false);
	});

	test("an empty or whitespace query matches everything", () => {
		expect(sessionMatchesQuery(target, "")).toBe(true);
		expect(sessionMatchesQuery(target, "   ")).toBe(true);
	});
});

describe("groupSessions", () => {
	test("orders buckets, sorts newest first inside them, and drops empty ones", () => {
		const buckets = groupSessions(
			[
				session({ id: "old", updatedAt: NOW - 90 * DAY }),
				session({ id: "today-older", updatedAt: NOW - 3_600_000 }),
				session({ id: "today-newest", updatedAt: NOW - 60_000 }),
				session({ id: "last-week", updatedAt: NOW - 4 * DAY }),
			],
			{ now: NOW },
		);

		expect(buckets.map((bucket) => bucket.id)).toEqual(["today", "week", "older"]);
		expect(buckets[0]?.sessions.map((s) => s.id)).toEqual(["today-newest", "today-older"]);
		expect(buckets[0]?.label).toBe("Today");
	});

	test("filters before bucketing so a bucket left empty disappears", () => {
		const buckets = groupSessions(
			[
				session({ id: "a", title: "Fix the CI build" }),
				session({ id: "b", title: "Write docs", updatedAt: NOW - 3 * DAY }),
			],
			{ now: NOW, query: "docs" },
		);

		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.id).toBe("week");
		expect(buckets[0]?.sessions.map((s) => s.id)).toEqual(["b"]);
	});
});

describe("relativeSessionTime", () => {
	test("steps from minutes to days", () => {
		expect(relativeSessionTime(NOW - 30_000, NOW)).toBe("now");
		expect(relativeSessionTime(NOW - 5 * 60_000, NOW)).toBe("5m");
		expect(relativeSessionTime(NOW - 3 * 3_600_000, NOW)).toBe("3h");
		expect(relativeSessionTime(NOW - 2 * DAY, NOW)).toBe("2d");
	});

	test("switches to a date once past a week, adding the year only when it differs", () => {
		expect(relativeSessionTime(new Date("2026-08-04T10:00:00").getTime(), NOW)).toBe("8/4");
		expect(relativeSessionTime(new Date("2025-12-30T10:00:00").getTime(), NOW)).toBe("12/30/25");
	});
});
