import { expect, test } from "bun:test";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionSummary } from "../../../src/shared/agent";
import { useStableSessionRows } from "../../../src/renderer/src/hooks/useStableSessionRows";

test("React updates preserve positions while showing the newest row data", () => {
	const row = (id: string, updatedAt: number): SessionSummary => ({ id, sessionFile: id, cwd: "/p", title: id, titlePending: false, preview: "", createdAt: updatedAt, updatedAt, messageCount: 1 });
	const newer = row("newer", 20);
	const older = row("older", 10);
	const refreshed = { ...older, title: "Updated", updatedAt: 9999, running: true };
	const snapshots = [[newer, older], [refreshed, newer]];
	function SidebarRows() {
		const [step, setStep] = useState(0);
		const rows = useStableSessionRows(snapshots[step]);
		if (step === 0) setStep(1);
		return <>{rows.map((row) => <span key={row.id} data-id={row.id} data-running={row.running}>{row.title}</span>)}</>;
	}
	const html = renderToStaticMarkup(<SidebarRows />);
	expect(html.indexOf('data-id="newer"')).toBeLessThan(html.indexOf('data-id="older"'));
	expect(html).toContain('data-running="true">Updated');
});
