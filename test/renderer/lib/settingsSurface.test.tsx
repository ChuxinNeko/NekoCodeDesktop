import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../../../src/renderer/src/components/ui/button";
import {
	SettingsSurfaceContext,
	useSettingsSurface,
} from "../../../src/renderer/src/lib/settingsSurface";

function SurfaceProbe() {
	const settings = useSettingsSurface();
	return <span data-settings-surface={settings ? "popup" : undefined} />;
}

describe("settings surface scope", () => {
	test("ordinary UI does not opt into settings glass", () => {
		expect(renderToStaticMarkup(<SurfaceProbe />)).not.toContain("data-settings-surface");
	});

	test("nested picker components inherit the settings scope", () => {
		const html = renderToStaticMarkup(
			<SettingsSurfaceContext.Provider value={true}>
				<div><SurfaceProbe /></div>
			</SettingsSurfaceContext.Provider>,
		);
		expect(html).toContain('data-settings-surface="popup"');
	});

	test("a nested opt-out does not leak the scope to other surfaces", () => {
		const html = renderToStaticMarkup(
			<SettingsSurfaceContext.Provider value={true}>
				<SettingsSurfaceContext.Provider value={false}>
					<SurfaceProbe />
				</SettingsSurfaceContext.Provider>
			</SettingsSurfaceContext.Provider>,
		);
		expect(html).not.toContain("data-settings-surface");
	});
});

describe("button semantics on translucent settings surfaces", () => {
	test("the implicit primary variant is exposed for readable glass ink", () => {
		expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('data-variant="default"');
	});

	test("destructive and disabled semantics survive the material override", () => {
		const html = renderToStaticMarkup(
			<Button variant="destructive" disabled>Delete</Button>,
		);
		expect(html).toContain('data-variant="destructive"');
		expect(html).toContain("disabled");
	});
});