import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AcceptanceCenter, AcceptanceCheckCard } from "../../../src/renderer/src/components/chat/AcceptanceCenter";
import { I18nProvider } from "../../../src/renderer/src/i18n";
import { buildAcceptanceReport } from "../../../src/shared/acceptance";

test("the center remains available without evidence and never displays a passing task claim", () => {
	const report = buildAcceptanceReport([{ id: "u", type: "user", text: "Build settings", timestamp: 1 }]);
	const html = renderToStaticMarkup(<I18nProvider><AcceptanceCenter report={report} /></I18nProvider>);
	expect(html).toContain("验收");
	expect(html).toContain("0/0");
	expect(html).not.toContain("全部通过");
});

test("stale checks show their actual exit code and evidence and disable recheck while busy", () => {
	const html = renderToStaticMarkup(<I18nProvider><AcceptanceCheckCard check={{ id: "a", title: "Typecheck", kind: "command", status: "stale", toolCallId: "tool-a", evidenceToolCallIds: ["tool-a"], output: "actual log", outputTruncated: true, startedAt: 1, finishedAt: 2, exitCode: 0 }} disabled onRecheck={() => {}} /></I18nProvider>);
	expect(html).toContain("需重新验证");
	expect(html).toContain("退出码 0");
	expect(html).toContain("actual log");
	expect(html).toContain("tool-a");
	expect(html).toContain("disabled");
	expect(html).toContain("完整日志");
});
