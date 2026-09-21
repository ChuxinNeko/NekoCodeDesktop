import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { iosBuildPlan } from "./build-ios";

test("iOS release uses an unsigned arm64 device build and preserves SemVer in the filename", () => {
	const plan = iosBuildPlan("1.2.3-beta.2+build.9", "42");
	expect(plan.version).toBe("1.2.3");
	expect(plan.buildNumber).toBe("42");
	expect(plan.filename).toBe("NekoCode-1.2.3-beta.2+build.9-ios-unsigned.ipa");
	expect(plan.settings).toContain("CODE_SIGNING_ALLOWED=NO");
	expect(plan.settings).toContain("CODE_SIGNING_REQUIRED=NO");
	expect(plan.settings).toContain("ARCHS=arm64");
	expect(plan.settings).toContain("MARKETING_VERSION=1.2.3");
});

test("invalid versions and build settings are rejected before invoking Xcode", () => {
	for (const version of ["v1.2.3", "1.2", "../1.2.3", "1.2.3 extra"]) expect(() => iosBuildPlan(version)).toThrow();
	for (const number of ["0", "-1", "1.2", "1 CODE_SIGNING_ALLOWED=YES", "1000000000"]) expect(() => iosBuildPlan("1.2.3", number)).toThrow();
});

test("iOS includes LAN and camera usage descriptions and the preferences privacy resource", () => {
	const plist = readFileSync(new URL("../mobile/ios/App/App/Info.plist", import.meta.url), "utf8");
	for (const key of ["NSCameraUsageDescription", "NSLocalNetworkUsageDescription", "NSAllowsLocalNetworking"]) expect(plist).toContain(`<key>${key}</key>`);
	expect(plist).not.toContain("NSAllowsArbitraryLoads");
	const project = readFileSync(new URL("../mobile/ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8");
	expect(project).toContain("PrivacyInfo.xcprivacy in Resources */,");
	const privacy = readFileSync(new URL("../mobile/ios/App/App/PrivacyInfo.xcprivacy", import.meta.url), "utf8");
	expect(privacy).toContain("NSPrivacyAccessedAPICategoryUserDefaults");
	expect(privacy).toContain("CA92.1");
});
