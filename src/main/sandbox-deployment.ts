import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "ssh2";
import type { SandboxDeployment } from "../shared/ssh";

const FILES = ["bootstrap.sh", "setup.sh", "Dockerfile", "control.py", "network.py", "download-runtime.py", "select-mirror.py", "entrypoint.py", "session.sh", "sshd_config", ".dockerignore"];

/** Read from the bundled app (including asar), or the source tree during tests. */
export function sandboxBundle(directory = existsSync(resolve(__dirname, "sandbox/bootstrap.sh"))
	? resolve(__dirname, "sandbox") : resolve(__dirname, "../../server/sandbox")) {
	const files = Object.fromEntries(FILES.map(name => [name, readFileSync(resolve(directory, name), "utf8").replace(/\r\n/g, "\n")]));
	const payload = JSON.stringify(files);
	return { files, payload, version: createHash("sha256").update(payload).digest("hex") };
}

export function deploymentScript(bundle = sandboxBundle()): string {
	// All bytes originate from the shipped app, never from host names or user commands.
	return bundle.files["bootstrap.sh"].replace("# NEKOCODE_PAYLOAD", `NEKOCODE_VERSION='${bundle.version}'\nNEKOCODE_PAYLOAD='${Buffer.from(bundle.payload).toString("base64")}'\nexport NEKOCODE_VERSION NEKOCODE_PAYLOAD`);
}

export async function deploySandbox(client: Client, hostId: string, report: (state: SandboxDeployment) => void): Promise<void> {
	report({ hostId, phase: "checking" });
	try {
		const script = deploymentScript();
		await new Promise<void>((resolve, reject) => {
			client.exec("sh -s", (error, stream) => {
				if (error) return reject(error);
				let tail = "", pending = "", settled = false;
				const finish = (error?: Error) => {
					if (settled) return;
					settled = true; clearTimeout(timer);
					error ? reject(error) : resolve();
				};
				const timer = setTimeout(() => {
					finish(new Error("Sandbox deployment exceeded 30 minutes. Check server connectivity and retry."));
					stream.close();
				}, 30 * 60_000);
				const consume = (data: Buffer) => {
					const text = data.toString(); tail = (tail + text).slice(-6000);
					pending += text;
					const lines = pending.split("\n"); pending = lines.pop()!.slice(-4096);
					for (const line of lines) {
						const phase = line.trim().match(/^NEKOCODE_STAGE:(dependencies|runtime|image|network)$/)?.[1];
						if (phase) report({ hostId, phase: phase as SandboxDeployment["phase"] });
					}
				};
				stream.on("data", consume); stream.stderr.on("data", consume);
				stream.on("error", finish);
				stream.on("close", (code: number | null) => finish(code === 0 ? undefined : new Error(`Sandbox deployment failed: ${tail.trim() || "SSH connection closed"}`)));
				// Parse the entire function before executing it. A ready installation
				// exits early; leaving script bytes unread can close SSH stdin before
				// sshd has delivered the command's exit status.
				stream.end(`nekocode_deploy() {\n${script}\n}\nnekocode_deploy\n`);
			});
		});
		report({ hostId, phase: "ready" });
	} catch (error) {
		report({ hostId, phase: "error", error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}
