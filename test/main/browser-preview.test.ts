import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { BrowserPreview, isServerCommand, localServerUrls } from "../../src/main/browser-preview";
import type { AgentCell } from "../../src/shared/agent";

const scopes: BrowserPreview[] = [];
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const scope of scopes.splice(0)) scope.dispose();
	for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function workspace() {
	const root = await mkdtemp(join(tmpdir(), "neko-preview-")); roots.push(root);
	const events: unknown[] = [];
	const scope = new BrowserPreview({ cwd: root, sessionId: "session", onPreview: request => events.push(request) }); scopes.push(scope);
	return { root, scope, events };
}
function shell(command: string, output: string, status: "done" | "error" = "done"): AgentCell {
	return { id: "shell", type: "tool", toolCallId: "shell", toolName: "bash", args: { command }, output, status, timestamp: 1 };
}
async function server(status = 200) {
	const server = createServer((_req, res) => res.writeHead(status).end("<button>Interactive app</button>")); servers.push(server);
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address() as { port: number };
	return `http://127.0.0.1:${address.port}/`;
}

test("static pages and assets resolve without publishing an unsolicited dock event", async () => {
	const { root, scope, events } = await workspace();
	await mkdir(join(root, "site"));
	await writeFile(join(root, "site/index.html"), '<script src="app.js"></script><button>Click</button>');
	await writeFile(join(root, "site/app.js"), 'document.querySelector("button").onclick=()=>alert("works")');
	const preview = await scope.resolveFrontend(["site/style.css"], []);
	expect(preview).toMatchObject({ sessionId: "session", cwd: root, kind: "html" });
	expect(await (await fetch(preview!.url)).text()).toContain("<button>Click</button>");
	expect(await (await fetch(new URL("app.js", preview!.url))).text()).toContain("onclick");
	expect(events).toEqual([]);
});

test("framework entries need a real running server; source files are not served as applications", async () => {
	const { root, scope } = await workspace();
	await writeFile(join(root, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
	await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { vite: "1" } }));
	expect(await scope.resolveFrontend(["index.html", "src/main.tsx"], [])).toBeNull();
	const url = await server();
	expect(await scope.resolveFrontend(["src/main.tsx"], [shell("npm run dev", `Local: ${url}`)])).toMatchObject({ url, kind: "server" });
});

test("untrusted prose, failed launches, and redirects do not supply preview URLs", async () => {
	const { scope } = await workspace();
	const url = await server();
	for (const cells of [[shell(`echo ${url}`, url)], [shell("npm run dev", url, "error")]]) {
		expect(await scope.resolveFrontend(["app.tsx"], cells)).toBeNull();
	}
	const redirect = await server(302);
	expect(await scope.resolveFrontend(["app.tsx"], [shell("npm run dev", redirect)])).toBeNull();
});

test("static preview cannot escape the session root and disposed scopes cannot resolve", async () => {
	const { scope } = await workspace();
	const outside = await mkdtemp(join(tmpdir(), "neko-outside-")); roots.push(outside);
	await writeFile(join(outside, "index.html"), "secret");
	expect(await scope.resolveFrontend([join(outside, "index.html")], [])).toBeNull();
	scope.dispose();
	expect(await scope.resolveFrontend(["index.html"], [])).toBeNull();
});

test("only explicit loopback addresses and real server commands are detected", () => {
	expect(localServerUrls("Local: http://0.0.0.0:5173/\nhttps://example.com:443/")).toEqual(["http://127.0.0.1:5173/"]);
	expect(isServerCommand("pnpm run dev --host")).toBe(true);
	expect(isServerCommand("cat README.md")).toBe(false);
	expect(isServerCommand("echo npm run dev")).toBe(false);
});
