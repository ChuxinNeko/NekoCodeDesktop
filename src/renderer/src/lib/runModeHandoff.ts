import type { DraggedSession } from "./sessionDrag";

export const RUN_MODE_SESSION_KEY = "nekocode:run-mode-session";
export const RUN_MODE_PREPARE_EVENT = "nekocode:prepare-run-mode";

export function parseRunModeSession(value: string | null): DraggedSession | null {
	if (!value) return null;
	try {
		const session = JSON.parse(value);
		if (!session || typeof session.id !== "string" || typeof session.cwd !== "string" || typeof session.sessionFile !== "string"
			|| (session.agentId !== undefined && typeof session.agentId !== "string")) return null;
		return { id: session.id, cwd: session.cwd, sessionFile: session.sessionFile, ...(session.agentId ? { agentId: session.agentId } : {}) };
	} catch { return null; }
}
