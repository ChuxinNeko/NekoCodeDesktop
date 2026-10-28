import { expect, test } from "bun:test";
import { parseRunModeSession } from "../../../src/renderer/src/lib/runModeHandoff";

test("restores the same local or ACP conversation instead of starting a new chat", () => {
	const local = { id: "session-1", cwd: "/root/project", sessionFile: "/home/morax/.config/NekoCode Desktop/sessions/session.jsonl" };
	expect(parseRunModeSession(JSON.stringify(local))).toEqual(local);
	const acp = { ...local, id: "acp:codex:session-1", agentId: "codex" };
	expect(parseRunModeSession(JSON.stringify(acp))).toEqual(acp);
	for (const value of [null, "bad json", "null", "{}", JSON.stringify({ ...local, cwd: 1 })]) expect(parseRunModeSession(value)).toBe(null);
});
