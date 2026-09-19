import { describe, expect, test } from "bun:test";
import { compareVersions, parseVersion } from "./updates";

describe("release version comparison", () => {
	test.each([
		["v1.10.0", "1.9.0", 1], ["1.2.10", "1.2.9", 1],
		["v1.2.3", "1.2.3", 0], ["1.2.3+build.2", "v1.2.3+build.1", 0],
		["1.2.3", "1.2.3-rc.1", 1], ["1.2.3-beta.10", "1.2.3-beta.2", 1],
		["1.2.3-alpha", "1.2.3-alpha.1", -1], ["1.2.3-1", "1.2.3-alpha", -1],
		["0.9.0", "1.0.0-beta", -1], ["2.0.0", "1.99.99", 1],
	] as const)("%s compared with %s", (a, b, expected) => {
		expect(compareVersions(a, b)).toBe(expected);
	});
	test.each(["latest", "1.2", "01.2.3", "1.2.3-01", "1.2.3-beta..1", "1.2.3.4", "1.2.3<script>", ""])("rejects invalid version %s", (version) => {
		expect(parseVersion(version)).toBeNull();
		expect(compareVersions(version, "1.0.0")).toBeNull();
	});
});
