import { expect, test } from "bun:test";
import { releasePlan } from "./release-plan";

test("a version bump publishes all platforms, unchanged versions do not build", () => {
	expect(releasePlan("0.0.3", "0.0.2", false, false)).toEqual({ build: true, publish: true, version: "0.0.3", tag: "v0.0.3", prerelease: false });
	expect(releasePlan("0.0.2", "0.0.2", false, false).build).toBe(false);
	expect(() => releasePlan("0.0.1", "0.0.2", false, false)).toThrow("must increase");
	expect(releasePlan("0.1.0-beta.1", "0.0.2", false, false).prerelease).toBe(true);
});

test("manual runs can build artifacts without publishing", () => {
	expect(releasePlan("0.0.2", null, true, false).publish).toBe(false);
	expect(releasePlan("0.0.2", null, true, false).build).toBe(true);
	expect(releasePlan("0.0.2", null, true, true).publish).toBe(true);
});
