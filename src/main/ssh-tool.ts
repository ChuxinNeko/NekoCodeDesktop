import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { SshHost } from "../shared/ssh";
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS, SKIPPED_UPLOAD_DIRS, type SshService } from "./ssh-service";
import type { SshStore } from "./ssh-store";
import { resolveWorkspacePath } from "./workflow-paths";

/**
 * The SSH servers saved in settings, for the agent: run a command, move files
 * over SFTP, look around. What "debug locally, deploy to the server" needs
 * without an ssh or scp binary, and without the password ever reaching the
 * model — it names a host, main holds the credentials.
 *
 * Local paths stay inside the workspace, the same as every other file tool:
 * an upload is not a way to ship ~/.ssh somewhere.
 */

export const SSH_TOOL_NAME = "ssh";

let source: () => { store: SshStore; service: SshService } | null = () => null;

export function configureSshTool(value: () => { store: SshStore; service: SshService } | null): void {
	source = value;
}

/** Whether any host is saved: the tool is only offered then. */
export function sshToolAvailable(): boolean {
	return (source()?.store.hosts().length ?? 0) > 0;
}

const OPS = ["hosts", "exec", "upload", "download", "ls"] as const;
type Op = (typeof OPS)[number];
/** Characters of output per stream handed back; the tail is what explains a failure. */
const OUTPUT_CHARS = 30_000;

const schema = Type.Object(
	{
		op: Type.Union(OPS.map((op) => Type.Literal(op)), {
			description:
				"hosts: the saved servers. exec: run a shell command on the server. upload: copy a workspace file or directory to the server (directories skip .git and node_modules). download: copy a remote file or directory into the workspace. ls: list a remote directory.",
		}),
		host: Type.Optional(Type.String({ description: "Saved host name or id (see op=hosts). Optional when only one host is saved." })),
		command: Type.Optional(Type.String({ description: "POSIX shell command (exec). Non-interactive: no prompts, no sudo password, no editors." })),
		cwd: Type.Optional(Type.String({ description: "Remote working directory (exec). Relative paths resolve against the host's remote directory." })),
		timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EXEC_TIMEOUT_MS / 1000, description: `Seconds before exec is killed. Defaults to ${DEFAULT_EXEC_TIMEOUT_MS / 1000}.` })),
		local: Type.Optional(Type.String({ description: "Workspace path (upload source, download target)." })),
		remote: Type.Optional(Type.String({ description: "Remote path (upload target, download source, ls). Relative paths resolve against the host's remote directory, else the login home." })),
	},
	{ additionalProperties: false },
);

type Input = Static<typeof schema>;

function need<T>(value: T | undefined, name: string, op: Op): T {
	if (value === undefined || value === null || (typeof value === "string" && !value.trim())) throw new Error(`${op} needs ${name}`);
	return value;
}

function describeHost(host: SshHost): string {
	return `${host.name} — ${host.username}@${host.host}:${host.port}${host.desktopMode === "sandbox" ? ` · gVisor sandbox · dir ${host.sandboxDir ?? "/home/neko/workspace"}` : host.remoteDir ? ` · dir ${host.remoteDir}` : ""} · id ${host.id}`;
}

export function pickHost(hosts: SshHost[], ref: string | undefined, find: (ref: string) => SshHost | null): SshHost {
	if (!hosts.length) throw new Error("No SSH hosts are saved. Ask the user to add one in Settings → SSH.");
	if (!ref?.trim()) {
		if (hosts.length === 1) return hosts[0];
		throw new Error(`Several SSH hosts are saved; pass host. Saved:\n${hosts.map(describeHost).join("\n")}`);
	}
	const host = find(ref);
	if (!host) throw new Error(`No saved SSH host matches "${ref}". Saved:\n${hosts.map(describeHost).join("\n")}`);
	return host;
}

function tail(text: string): string {
	return text.length > OUTPUT_CHARS ? `…(${text.length - OUTPUT_CHARS} earlier characters omitted)\n${text.slice(-OUTPUT_CHARS)}` : text;
}

function size(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function createSshTool(cwd: string, options: { assertWritable?: (path: string) => void } = {}): ToolDefinition {
	return {
		name: SSH_TOOL_NAME,
		label: SSH_TOOL_NAME,
		description:
			"Work on saved SSH environments; credentials stay with the app. For a host configured in sandbox mode, ALL commands, file transfers and terminals use its isolated gVisor desktop sandbox, never the host filesystem. exec runs a non-interactive shell; upload/download transfer files; ls lists a directory; hosts identifies each environment. The remote desktop uses the same sandbox. Remote commands have real effects: run only what the task calls for.",
		promptSnippet: "ssh(op=hosts|exec|upload|download|ls, host?) runs commands and transfers files on the user's saved SSH servers.",
		parameters: schema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const input = params as Input;
			const ssh = source();
			if (!ssh) throw new Error("SSH is unavailable in this session");
			const hosts = ssh.store.hosts();
			const op = input.op as Op;
			if (op === "hosts") {
				const text = hosts.length ? hosts.map(describeHost).join("\n") : "No SSH hosts are saved. The user can add one in Settings → SSH.";
				return { content: [{ type: "text", text }], details: { op } };
			}
			const host = pickHost(hosts, input.host, (ref) => ssh.store.find(ref));
			let text: string;
			switch (op) {
				case "exec": {
					const command = need(input.command, "command", op);
					const result = await ssh.service.exec(host.id, command, {
						cwd: input.cwd,
						timeoutMs: input.timeout ? input.timeout * 1000 : undefined,
						signal,
					});
					const status = result.timedOut
						? `timed out after ${input.timeout ?? DEFAULT_EXEC_TIMEOUT_MS / 1000}s; termination was requested`
						: result.signal ? `killed by ${result.signal}` : `exit code ${result.code ?? "unknown"}`;
					text = [
						`[${host.name}] ${status}`,
						result.stdout ? `--- stdout ---\n${tail(result.stdout)}` : "",
						result.stderr ? `--- stderr ---\n${tail(result.stderr)}` : "",
						!result.stdout && !result.stderr ? "(no output)" : "",
						result.truncated ? `(${size(result.truncated)} of earlier output was dropped)` : "",
					].filter(Boolean).join("\n");
					break;
				}
				case "upload": {
					const local = resolveWorkspacePath(cwd, need(input.local, "local", op));
					const result = await ssh.service.upload(host.id, local, need(input.remote, "remote", op), signal);
					text = `Uploaded ${result.files} file(s), ${size(result.bytes)}, to ${host.name}:${result.target}` +
						(result.skipped.length ? `\nSkipped (${[...SKIPPED_UPLOAD_DIRS].join(", ")}): ${result.skipped.length} director${result.skipped.length === 1 ? "y" : "ies"}` : "");
					break;
				}
				case "download": {
					const localInput = need(input.local, "local", op);
					const local = resolveWorkspacePath(cwd, localInput);
					options.assertWritable?.(localInput);
					const result = await ssh.service.download(host.id, need(input.remote, "remote", op), local, signal);
					text = `Downloaded ${result.files} file(s), ${size(result.bytes)}, from ${host.name}:${input.remote} to ${localInput}`;
					break;
				}
				case "ls": {
					const { path, entries } = await ssh.service.list(host.id, input.remote ?? ".");
					text = [
						`${host.name}:${path} (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`,
						...entries.map((entry) =>
							`  ${entry.type === "directory" ? `${entry.name}/` : entry.type === "symlink" ? `${entry.name}@` : entry.name}` +
							(entry.type === "file" ? `  ${size(entry.size)}` : "") +
							`  ${new Date(entry.modified).toISOString().slice(0, 16).replace("T", " ")}`,
						),
					].join("\n");
					break;
				}
				default:
					throw new Error(`Unknown op: ${String(input.op)}`);
			}
			return { content: [{ type: "text", text }], details: { op, host: host.name } };
		},
	};
}
