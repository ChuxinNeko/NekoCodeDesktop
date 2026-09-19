import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	dayKey,
	shiftDay,
	type TokenBucket,
	type TokenUsageReport,
} from "../shared/tokenStats";

// Same bridge stand-in as the other renderer tests: importing a settings panel
// must not reach for Electron's preload API.
const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { TokenUsageDashboard } = await import(
	"../renderer/src/components/settings/TokenUsageSettings"
);
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const TODAY = dayKey(Date.now());

function bucket(patch: Partial<TokenBucket> = {}): TokenBucket {
	return {
		date: TODAY,
		provider: "nekocode-1",
		model: "glm-5.3",
		cwd: "/work/app",
		calls: 2,
		input: 1000,
		output: 500,
		cacheRead: 3000,
		cacheWrite: 1000,
		reasoning: 120,
		costUsd: 0.25,
		...patch,
	};
}

function report(patch: Partial<TokenUsageReport> = {}): TokenUsageReport {
	return {
		generatedAt: Date.now(),
		buckets: [bucket()],
		hours: [{ date: TODAY, hour: 14, tokens: 5500, calls: 2 }],
		sessions: [
			{
				id: "s1",
				file: "/sessions/s1.jsonl",
				title: "Token panel",
				cwd: "/work/app",
				kind: "session",
				startedAt: Date.now() - 3600_000,
				updatedAt: Date.now(),
				calls: 2,
				input: 1000,
				output: 500,
				cacheRead: 3000,
				cacheWrite: 1000,
				reasoning: 120,
				costUsd: 0.25,
			},
		],
		providerLabels: { "nekocode-1": "Z.ai" },
		files: { scanned: 3, failed: 0 },
		scanMs: 12,
		...patch,
	};
}

const render = (value: TokenUsageReport) =>
	renderToStaticMarkup(
		createElement(I18nProvider, {
			children: createElement(TokenUsageDashboard, { report: value }),
		}),
	);

describe("TokenUsageDashboard", () => {
	test("leads with the total and shows the parts that make it up", () => {
		const markup = render(report());
		// 1000 + 500 + 3000 + 1000
		expect(markup).toContain("5,500");
		expect(markup).toContain("1,000");
		expect(markup).toContain("3,000");
	});

	test("reports the cache hit rate against the prompt, not the total", () => {
		// 3000 cache read of (1000 input + 3000 read + 1000 write) = 60%.
		expect(render(report())).toContain("60.0%");
	});

	test("names the provider by the label the endpoint was saved under", () => {
		const markup = render(report());
		expect(markup).toContain("Z.ai");
		expect(markup).not.toContain("nekocode-1");
	});

	test("draws one square per day of the rolling year", () => {
		const markup = render(report());
		// 365 days padded out to whole weeks, minus the padding cells, which are
		// rendered as empty spans rather than buttons.
		const squares = markup.match(/<button[^>]*aria-pressed/g) ?? [];
		expect(squares.length).toBe(365);
	});

	test("a period with nothing in it says so instead of showing zeroes", () => {
		const stale = report({
			buckets: [bucket({ date: shiftDay(TODAY, -200) })],
			sessions: [],
		});
		// Default range is 30 days, and the only activity is 200 days back.
		expect(render(stale)).toContain("该时间段内没有消耗");
	});

	test("renders without any usage at all rather than throwing", () => {
		const markup = render(report({ buckets: [], hours: [], sessions: [] }));
		expect(markup).toContain("该时间段内没有消耗");
		expect(markup).toContain("0");
	});

	test("marks a scheduled run so its tokens are not read as a chat", () => {
		const scheduled = report({
			sessions: [{ ...report().sessions[0], kind: "automation" }],
		});
		expect(render(scheduled)).toContain("定时任务");
	});

	test("puts the injected actions in the control row", () => {
		const markup = renderToStaticMarkup(
			createElement(I18nProvider, {
				children: createElement(TokenUsageDashboard, {
					report: report(),
					actions: createElement("span", null, "REFRESH-SLOT"),
				}),
			}),
		);
		expect(markup).toContain("REFRESH-SLOT");
	});
});
