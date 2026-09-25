import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { readGoalState, type GoalState } from "../../../../shared/goal";
import { I18nProvider } from "../../i18n";
import { GoalBanner } from "./GoalBanner";

const render = (goal: GoalState) =>
	renderToString(
		<I18nProvider>
			<GoalBanner goal={goal} onAction={async () => {}} />
		</I18nProvider>,
	);

// What the previous main-process build sent: no clock, no usage, `note` instead of `reason`.
const old = { objective: "让测试通过", status: "paused", turns: 2, maxTurns: 30, startedAt: 1, updatedAt: 2, note: "已手动暂停" };

describe("GoalBanner with a goal one version behind", () => {
	test("rendered raw, it throws — the white screen", () => {
		expect(() => render(old as never)).toThrow(/tokens/);
	});

	test("read through readGoalState first, it renders", () => {
		const goal = readGoalState(old);
		expect(goal).not.toBeNull();
		const html = render(goal!);
		expect(html).toContain("让测试通过");
		expect(html).toContain("已手动暂停");
		expect(html).toMatch(/>0(<!-- -->)? tokens</);
	});
});
