import { expect, test } from "bun:test";
import { releasePlan } from "../../scripts/release-plan";

test("version bumps build and publish a matching release tag", () => {
	expect(releasePlan("0.2.0", "0.1.0", false, false)).toEqual({ build: true, publish: true, version: "0.2.0", tag: "v0.2.0", prerelease: false });
});
test("other package.json edits do not publish the same version again", () => {
	expect(releasePlan("0.1.0", "0.1.0", false, false)).toMatchObject({ build: false, publish: false });
});
test("downgrades and invalid versions stop the release", () => {
	expect(() => releasePlan("0.1.0", "0.2.0", false, false)).toThrow("increase");
	expect(() => releasePlan("v0.2.0", "0.1.0", false, false)).toThrow("SemVer");
	expect(() => releasePlan("latest", null, true, true)).toThrow("SemVer");
});
test("manual builds publish only when explicitly selected", () => {
	expect(releasePlan("0.1.0", null, true, false)).toMatchObject({ build: true, publish: false });
	expect(releasePlan("0.1.0", null, true, true)).toMatchObject({ build: true, publish: true });
});
test("prereleases remain prereleases and a first push can publish", () => {
	expect(releasePlan("1.0.0-beta.1", "0.9.0", false, false).prerelease).toBe(true);
	expect(releasePlan("0.1.0", null, false, false)).toMatchObject({ build: true, publish: true });
});
