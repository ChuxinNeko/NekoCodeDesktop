import { describe, expect, test } from "bun:test";
import { isPluginSource, pluginPackageName } from "./plugins";

describe("plugin sources", () => {
	test("catalog identity ignores npm versions without losing scoped names", () => {
		expect(pluginPackageName("npm:@owner/pkg@1.2.3")).toBe("@owner/pkg");
		expect(pluginPackageName("npm:@owner/pkg")).toBe("@owner/pkg");
		expect(pluginPackageName("npm:pi-example@latest")).toBe("pi-example");
		expect(pluginPackageName("npm:pi-example")).toBe("pi-example");
		expect(pluginPackageName("git:github.com/owner/pkg")).toBeNull();
	});
	test("accepts the four shapes pi installs from", () => {
		for (const source of [
			"npm:@scope/pkg",
			"npm:pkg@1.2.3",
			"git:github.com/user/repo@v1",
			"git:git@github.com:user/repo",
			"https://github.com/user/repo",
			"./local/package",
			"/absolute/path",
			"C:\\Users\\me\\package",
		])
			expect(isPluginSource(source)).toBe(true);
	});

	test("rejects what would only surface as an installer error later", () => {
		for (const source of [
			"",
			"   ",
			"react",
			"npm: @scope/pkg",
			"rm -rf /",
			"x".repeat(501),
		])
			expect(isPluginSource(source)).toBe(false);
	});

	test("tolerates the whitespace a paste brings with it", () => {
		expect(isPluginSource("  npm:@scope/pkg  ")).toBe(true);
	});
});
