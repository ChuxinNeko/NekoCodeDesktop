import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { AcpAgentInfo, AcpSessionSnapshot } from "../../../../src/shared/acp";
import { AcpChatView } from "../../../../src/renderer/src/components/agents/AcpChatView";
import { I18nProvider } from "../../../../src/renderer/src/i18n";

const agent: AcpAgentInfo = { id: "codex", name: "Codex", description: "Codex ACP", command: "", args: [],
	env: {}, enabled: true, builtin: true, commandLine: "" };
const snapshot: AcpSessionSnapshot = { id: "codex-session", agentSessionId: "history-session", agentId: "codex",
	agentName: "Codex", cwd: "D:/work/project", title: "ACP history", status: "ready", pristine: false,
	createdAt: 1, updatedAt: 1, streaming: false, configOptions: [], commands: [], permissions: [], supportsImages: false,
	cells: [{ id: "acp:user/1", type: "user", text: "First ACP prompt", timestamp: 1 },
		{ id: "acp:user/2", type: "user", text: "Second ACP prompt", timestamp: 2 }] };
const noop = () => {};
const render = (value: AcpSessionSnapshot | null, mobile = false) => renderToString(<I18nProvider>
	<AcpChatView agent={agent} snapshot={value} cwd={snapshot.cwd} error={null} historyError={null} composerHeader={null}
		mobile={mobile} onDismissError={noop} onPickProject={noop} onSend={noop} onAbort={noop}
		onSetConfig={noop} onRespondPermission={noop} />
</I18nProvider>);

describe("Codex ACP timeline integration", () => {
	test("mounts the timeline in the actual ACP view, including loaded history and a streaming turn", () => {
		const history = render(snapshot);
		expect(history).toContain("data-conversation-timeline");
		expect(history).toContain('data-user-cell="acp:user/1"');
		expect(history).toContain("First ACP prompt");
		const live = render({ ...snapshot, streaming: true, status: "prompting", cells: [...snapshot.cells,
			{ id: "acp:user/3", type: "user", text: "Third ACP prompt", timestamp: 3 }] });
		expect(live).toContain('data-timeline-index="1"');
	});
	test("does not mount desktop navigation in an empty ACP session or the mobile view", () => {
		expect(render({ ...snapshot, cells: [] })).not.toContain("data-conversation-timeline");
		expect(render({ ...snapshot, cells: snapshot.cells.slice(0, 1) })).not.toContain("data-conversation-timeline");
		expect(render(snapshot, true)).not.toContain("data-conversation-timeline");
	});
});
