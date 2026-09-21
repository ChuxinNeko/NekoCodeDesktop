import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseVersion } from "../src/shared/updates";

/** Apple bundle versions cannot contain SemVer prerelease or build suffixes. */
export function iosBuildPlan(version: string, buildNumber = "1") {
	const parsed = parseVersion(version);
	if (!parsed || version.startsWith("v")) throw new Error("Invalid package.json version");
	if (!/^[1-9]\d{0,8}$/.test(buildNumber)) throw new Error("IOS_BUILD_NUMBER must be a positive integer of at most 9 digits");
	return {
		version: parsed.core.map(String).join("."),
		buildNumber,
		filename: `NekoCode-${version}-ios-unsigned.ipa`,
		settings: [
			`MARKETING_VERSION=${parsed.core.map(String).join(".")}`,
			`CURRENT_PROJECT_VERSION=${buildNumber}`,
			"CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=", "DEVELOPMENT_TEAM=",
			"SKIP_INSTALL=NO", "ONLY_ACTIVE_ARCH=NO", "ARCHS=arm64",
		],
	};
}

async function buildIos(): Promise<void> {
	if (process.platform !== "darwin") throw new Error("iOS 打包需要 macOS/Xcode。请在 GitHub Actions 运行 Build and release（publish=false 仅构建）。");
	const root = resolve(import.meta.dir, "..");
	const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
	const plan = iosBuildPlan(version, process.env.IOS_BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER ?? "1");
	const run = (command: string, args: string[], cwd = root) => new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
	});
	await run(process.execPath, ["run", "mobile:build"]);
	await run(process.execPath, ["x", "--no-install", "cap", "sync", "ios"]);
	const out = join(root, "out/ios");
	mkdirSync(out, { recursive: true });
	const work = mkdtempSync(join(out, "build-"));
	const archive = join(work, "NekoCode.xcarchive");
	const project = join(root, "mobile/ios/App/App.xcodeproj");
	try {
		await run("xcodebuild", ["-project", project, "-scheme", "App", "-configuration", "Release",
			"-destination", "generic/platform=iOS", "-sdk", "iphoneos", "-archivePath", archive,
			"-derivedDataPath", join(work, "DerivedData"), ...plan.settings, "archive"]);
		const appsDir = join(archive, "Products/Applications");
		const apps = readdirSync(appsDir).filter((name) => name.endsWith(".app"));
		if (apps.length !== 1) throw new Error("Archive must contain exactly one iOS application");
		const stage = join(work, "ipa");
		const app = join(stage, "Payload", apps[0]);
		mkdirSync(join(stage, "Payload"), { recursive: true });
		cpSync(join(appsDir, apps[0]), app, { recursive: true });
		// Binary dependencies may arrive pre-signed. Remove signatures before users re-sign.
		const strip = async (directory: string): Promise<void> => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const file = join(directory, entry.name);
				if (entry.isSymbolicLink()) continue;
				if (entry.name === "embedded.mobileprovision") rmSync(file, { force: true });
				else if (entry.isDirectory() && entry.name !== "_CodeSignature") await strip(file);
				else if (entry.isFile() && entry.name.endsWith(".dylib")) {
					try { execFileSync("codesign", ["-d", file], { stdio: "ignore" }); }
					catch { continue; }
					await run("codesign", ["--remove-signature", file]);
				}
			}
			if (/\.(app|framework|appex)$/.test(directory)) {
				let signed = false;
				try { execFileSync("codesign", ["-d", directory], { stdio: "ignore" }); signed = true; } catch { /* Already unsigned. */ }
				if (signed) await run("codesign", ["--remove-signature", directory]);
			}
			rmSync(join(directory, "_CodeSignature"), { recursive: true, force: true });
		};
		await strip(app);
		const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(app, "Info.plist")], { encoding: "utf8" }));
		if (plist.CFBundleShortVersionString !== plan.version || plist.CFBundleVersion !== plan.buildNumber) throw new Error("IPA version metadata does not match the release");
		if (plist.CFBundleIdentifier !== "com.nekocode.mobile" || !plist.NSCameraUsageDescription || !plist.NSLocalNetworkUsageDescription) throw new Error("Missing iOS app identity or usage descriptions");
		if (!plist.CFBundleSupportedPlatforms?.includes("iPhoneOS")) throw new Error("Expected a device build, not a simulator build");
		for (const asset of ["public/index.html", "capacitor.config.json", "PrivacyInfo.xcprivacy"]) {
			if (!existsSync(join(app, asset))) throw new Error(`IPA is missing ${asset}`);
		}
		const arch = execFileSync("lipo", ["-archs", join(app, plist.CFBundleExecutable)], { encoding: "utf8" }).trim();
		if (arch !== "arm64") throw new Error(`Unexpected iOS architectures: ${arch}`);
		const destination = join(root, "dist/mobile", plan.filename);
		mkdirSync(join(root, "dist/mobile"), { recursive: true });
		rmSync(destination, { force: true });
		// Payload/App.app is required by AltStore/Sideloadly; exportArchive requires signing.
		await run("ditto", ["-c", "-k", "--keepParent", "--norsrc", join(stage, "Payload"), destination]);
		await run("unzip", ["-tq", destination]);
		console.log(`\nUnsigned iOS IPA (requires user signing): ${destination}`);
	} finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.main) await buildIos();
