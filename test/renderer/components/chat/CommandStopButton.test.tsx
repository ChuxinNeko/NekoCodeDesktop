import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCellData } from "../../../../src/shared/transcript";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { CommandStopContext } from "../../../../src/renderer/src/components/chat/CommandStopButton";
import { ToolCall } from "../../../../src/renderer/src/components/chat/ToolCalls";

function card(toolName: string, status: ToolCellData["status"], active: boolean, canStop = true) {
	const cell: ToolCellData = { type: "tool", id: "row", toolCallId: "command-id", toolName,
		args: { command: "sleep 30", op: "exec" }, output: "", status, timestamp: Date.now() };
	return renderToStaticMarkup(
		<I18nProvider>
			<CommandStopContext.Provider value={canStop ? async () => true : undefined}>
				<ToolCall cell={cell} active={active} />
			</CommandStopContext.Provider>
		</I18nProvider>,
	);
}

describe("command stop button", () => {
	for (const shell of ["bash", "powershell", "cmd"]) {
		test(`${shell} shows an accessible stop button only while executing`, () => {
			const markup = card(shell, "running", true);
			expect(markup).toContain('aria-label="停止命令"');
			// The card expansion closes before the stop button opens: no nested buttons.
			expect(markup).toMatch(/<\/button><span[^>]*><button[^>]*aria-label="停止命令"/);
			expect(card(shell, "done", false)).not.toContain('aria-label="停止命令"');
			expect(card(shell, "running", false)).not.toContain('aria-label="停止命令"');
		});
	}
	test("unsupported remote tools and surfaces without a stop bridge do not offer a false action", () => {
		expect(card("ssh", "running", true)).not.toContain('aria-label="停止命令"');
		expect(card("bash", "running", true, false)).not.toContain('aria-label="停止命令"');
	});
});
