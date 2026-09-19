import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { compareVersions, parseVersion } from "../src/shared/updates";

export function releasePlan(version: string, previous: string | null, manual: boolean, publish: boolean) {
	const parsed = parseVersion(version);
	if (!parsed || version.startsWith("v")) throw new Error("package.json version must be SemVer without a v prefix");
	const changed = previous !== version;
	if (!manual && changed && previous !== null) {
		const comparison = compareVersions(version, previous);
		if (comparison === null || comparison <= 0) throw new Error(`Release version must increase: ${previous} -> ${version}`);
	}
	return {
		build: manual || changed,
		publish: manual ? publish : changed,
		version,
		tag: `v${version}`,
		prerelease: parsed.prerelease.length > 0,
	};
}

if (import.meta.main) {
	const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
	const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
	let previous: string | null = null;
	const before = process.env.BEFORE_SHA;
	if (!manual && before && !/^0+$/.test(before)) {
		if (!/^[a-f0-9]{40}$/.test(before)) throw new Error("Invalid before SHA");
		// A missing base commit is an error, not permission to publish an unrelated version.
		previous = JSON.parse(execFileSync("git", ["show", `${before}:package.json`], { encoding: "utf8" })).version;
	}
	const plan = releasePlan(version, previous, manual, process.env.PUBLISH_RELEASE === "true");
	console.log(JSON.stringify(plan, null, 2));
	if (process.env.GITHUB_OUTPUT) {
		for (const [key, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
	}
}
