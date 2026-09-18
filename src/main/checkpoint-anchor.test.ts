import { describe, expect, test } from "bun:test";
import { cellIdForMessage, findTurnEntry, type AnchorEntry } from "./checkpoint-anchor";

const user = (id: string, message = { role: "user" }): AnchorEntry => ({ id, type: "message", message });
const assistant = (id: string): AnchorEntry => ({ id, type: "message", message: { role: "assistant" } });
const modelChange = (id: string): AnchorEntry => ({ id, type: "model_change" });
const custom = (id: string): AnchorEntry => ({ id, type: "custom_message" });

describe("findTurnEntry", () => {
	test("a null parent means the turn opened the session", () => {
		const branch = [user("u1"), assistant("a1"), user("u2")];
		expect(findTurnEntry(branch, null)?.id).toBe("u1");
	});

	test("the prompt is the first message after the stored parent", () => {
		const branch = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
		expect(findTurnEntry(branch, "a1")?.id).toBe("u2");
	});

	test("bookkeeping entries between the parent and the prompt are stepped over", () => {
		const branch = [
			user("u1"),
			assistant("a1"),
			modelChange("m1"),
			{ id: "t1", type: "thinking_level_change" },
			user("u2"),
		];
		expect(findTurnEntry(branch, "a1")?.id).toBe("u2");
	});

	test("a parent that is no longer on the branch has no turn", () => {
		// What a checkpoint from an abandoned branch looks like after a rewind.
		expect(findTurnEntry([user("u1"), assistant("a1")], "gone")).toBeNull();
	});

	test("an assistant message before the next prompt means the turn is gone", () => {
		// Rewinding to the prompt after it would undo work the checkpoint never
		// covered, so this reports nothing rather than the wrong turn.
		expect(findTurnEntry([modelChange("m1"), assistant("a1"), user("u2")], "m1")).toBeNull();
	});

	test("nothing after the parent means nothing to rewind to", () => {
		expect(findTurnEntry([user("u1"), assistant("a1")], "a1")).toBeNull();
	});

	test("an extension's custom message can open a turn too", () => {
		expect(findTurnEntry([assistant("a1"), custom("c1")], "a1")?.id).toBe("c1");
	});

	test("a null parent on an empty branch has no turn", () => {
		expect(findTurnEntry([], null)).toBeNull();
	});
});

describe("cellIdForMessage", () => {
	test("matches the id the projector derives from timestamp and index", () => {
		const prompt = { role: "user", timestamp: 1700 };
		const messages = [{ role: "user", timestamp: 1000 }, { role: "assistant", timestamp: 1500 }, prompt];

		expect(cellIdForMessage(messages, prompt)).toBe("user-1700-2");
	});

	test("a message with no timestamp lands on the projector's zero", () => {
		const prompt = { role: "user" };
		expect(cellIdForMessage([prompt], prompt)).toBe("user-0-0");
	});

	test("identity, not equality — an equal copy is not the same message", () => {
		const prompt = { role: "user", timestamp: 1700 };
		expect(cellIdForMessage([{ role: "user", timestamp: 1700 }], prompt)).toBeNull();
	});

	test("a message outside the context has no cell", () => {
		// Compacted away: still restorable as code, but with no row to hang on.
		expect(cellIdForMessage([], { role: "user", timestamp: 1 })).toBeNull();
	});

	test("no message at all has no cell", () => {
		expect(cellIdForMessage([{ role: "user" }], undefined)).toBeNull();
	});
});
