import { spawn } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseVersion } from "../src/shared/updates";

const root = resolve(import.meta.dir, "..");
const release = process.argv.includes("--release");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
if (!parseVersion(version) || version.startsWith("v")) throw new Error("Invalid package.json version");
if (release) {
	for (const key of ["ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD", "ANDROID_VERSION_CODE"]) {
		if (!process.env[key]) throw new Error(`Release APK requires ${key}`);
	}
	if (!existsSync(process.env.ANDROID_KEYSTORE_PATH!)) throw new Error("Android signing keystore not found");
	const code = Number(process.env.ANDROID_VERSION_CODE);
	if (!Number.isSafeInteger(code) || code <= 2 || code > 2_100_000_000) throw new Error("Release ANDROID_VERSION_CODE must be an integer between 3 and 2100000000");
}
const javaInstall = process.env.NEKOCODE_ANDROID_JAVA_HOME ?? process.env.JAVA_HOME;
const buildEnv = { ...process.env, ...(javaInstall ? { JAVA_HOME: javaInstall } : {}) };
async function run(command: string, args: string[], cwd = root): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd, env: buildEnv, stdio: "inherit", windowsHide: true });
		child.on("error", reject);
		child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
	});
}
await run(process.execPath, ["run", "mobile:build"]);
await run(process.execPath, ["x", "--no-install", "cap", "sync", "android"]);
const nativeDir = join(root, "mobile/android");
const variant = release ? "release" : "debug";
const task = release ? "assembleRelease" : "assembleDebug";
if (process.platform === "win32") await run("cmd.exe", ["/d", "/c", "gradlew.bat", task, "--console=plain"], nativeDir);
else await run("sh", ["gradlew", task, "--console=plain"], nativeDir);
const source = join(nativeDir, `app/build/outputs/apk/${variant}/app-${variant}.apk`);
if (!existsSync(source)) throw new Error("Gradle did not produce an APK");
const target = join(root, release ? `dist/mobile/NekoCode-${version}-android.apk` : "dist/mobile/NekoCode-Android-debug.apk");
mkdirSync(join(root, "dist/mobile"), { recursive: true });
copyFileSync(source, target);
console.log(`\nAndroid APK: ${target}`);
