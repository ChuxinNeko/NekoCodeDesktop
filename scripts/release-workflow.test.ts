import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as {
	jobs: Record<string, { needs?: string[]; steps: Array<{ uses?: string; with?: { script?: string } }> }>;
};
const script = workflow.jobs.release.steps.find((step) => step.uses === "actions/github-script@v8")!.with!.script!;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const execute = new AsyncFunction("require", "process", "context", "github", "core", script);

function fixture(includeAndroid: boolean, includeIos = true) {
	const version = "0.0.3";
	const names = ["win-x64.exe", "mac-x64.dmg", "mac-x64.zip", "mac-arm64.dmg", "mac-arm64.zip", "linux-x86_64.AppImage", "linux-amd64.deb"].map((suffix) => `NekoCode-Desktop-${version}-${suffix}`);
	if (includeAndroid) names.push(`NekoCode-${version}-android.apk`);
	if (includeIos) names.push(`NekoCode-${version}-ios-unsigned.ipa`);
	const files = new Map(names.map((name) => [name, Buffer.from(`fixture ${name}`)]));
	const uploaded: string[] = [];
	let published = false;
	let created = false;
	const missing = async () => { throw Object.assign(new Error("Not found"), { status: 404 }); };
	const github = {
		paginate: async () => [],
		rest: {
			git: { getRef: missing },
			repos: {
				getReleaseByTag: missing,
				generateReleaseNotes: async () => ({ data: { body: "Release notes" } }),
				createRelease: async () => { created = true; return { data: { id: 1, html_url: "https://example.test/release" } }; },
				listReleaseAssets: async () => [],
				uploadReleaseAsset: async ({ name }: { name: string }) => { uploaded.push(name); },
				updateRelease: async () => { expect(uploaded).toHaveLength(10); published = true; },
			},
		},
	};
	const run = () => execute((name: string) => {
		if (name === "node:crypto") return { createHash };
		if (name === "node:path") return path;
		if (name === "node:fs/promises") return {
			readdir: async () => [...files.keys()],
			readFile: async (file: string) => files.get(path.basename(file)),
			writeFile: async (file: string, content: string) => { files.set(path.basename(file), Buffer.from(content)); },
		};
		throw new Error(`Unexpected module ${name}`);
	}, { env: { RELEASE_VERSION: version, RELEASE_TAG: `v${version}`, RELEASE_PRERELEASE: "false" } },
	{ repo: { owner: "test", repo: "test" }, sha: "test-commit" }, github, { info: () => undefined });
	return { run, files, uploaded, created: () => created, published: () => published };
}

test("publication depends on Android and refuses to publish when its APK is missing", async () => {
	expect(workflow.jobs.release.needs).toContain("build-android");
	const f = fixture(false);
	await expect(f.run()).rejects.toThrow("NekoCode-0.0.3-android.apk");
	expect(f.created()).toBe(false);
	expect(f.published()).toBe(false);
});

test("Android APK and checksum upload before publishing the complete release", async () => {
	const f = fixture(true);
	await f.run();
	expect(f.published()).toBe(true);
	expect(f.uploaded).toContain("NekoCode-0.0.3-android.apk");
	expect(f.uploaded).toContain("NekoCode-0.0.3-ios-unsigned.ipa");
	const checksum = createHash("sha256").update(f.files.get("NekoCode-0.0.3-android.apk")!).digest("hex");
	expect(f.files.get("SHA256SUMS.txt")!.toString()).toContain(`${checksum}  NekoCode-0.0.3-android.apk`);
	const iosChecksum = createHash("sha256").update(f.files.get("NekoCode-0.0.3-ios-unsigned.ipa")!).digest("hex");
	expect(f.files.get("SHA256SUMS.txt")!.toString()).toContain(`${iosChecksum}  NekoCode-0.0.3-ios-unsigned.ipa`);
});

test("publication waits for iOS and cannot publish a release missing its IPA", async () => {
	expect(workflow.jobs.release.needs).toContain("build-ios");
	const f = fixture(true, false);
	await expect(f.run()).rejects.toThrow("NekoCode-0.0.3-ios-unsigned.ipa");
	expect(f.created()).toBe(false);
	expect(f.published()).toBe(false);
});
