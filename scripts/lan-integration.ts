/** Runs in an isolated Electron main process against a local, fake model API. */
import { app, type BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { AgentService } from "../src/main/agent-service";
import { TaskManager } from "../src/main/task-manager";
import { ModelConfigService } from "../src/main/model-config-service";
import { BrowserInspector } from "../src/main/browser-inspector";
import { LanService } from "../src/main/lan-service";
import { encodeLanPairing, parseLanPairing } from "../src/shared/lan-pairing";

const testDir = process.env.NEKOCODE_LAN_TEST_DIR!;
assert(testDir);
app.setPath("userData", testDir);
process.env.PI_CODING_AGENT_DIR = join(testDir, "agent");
const preview = process.argv.includes("--preview");
const workspace = join(testDir, "project");
mkdirSync(workspace, { recursive: true });
let manager: TaskManager | undefined;
let lan: LanService | undefined;
let inFlight = 0;
let peak = 0;
const model = createServer(async (req, res) => {
	for await (const _chunk of req) { /* Drain the local test prompt without logging it. */ }
	inFlight++; peak = Math.max(peak, inFlight);
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	const part = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "lan-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	part({ role: "assistant", content: "" });
	await new Promise((resolve) => setTimeout(resolve, 1500));
	part({ content: "已完成本地测试。两项任务独立运行，桌面与手机可以分别查看进度。" });
	part({}, "stop");
	res.end("data: [DONE]\n\n");
	inFlight--;
});
const until = async (predicate: () => boolean, label: string) => {
	const end = Date.now() + 20_000;
	while (!predicate()) {
		assert(Date.now() < end, `Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
};

void app.whenReady().then(async () => {
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const modelPort = (model.address() as { port: number }).port;
	const fakeWindow = { isDestroyed: () => false, webContents: { send: () => undefined } } as unknown as BrowserWindow;
	const config = new ModelConfigService();
	const inspector = new BrowserInspector(fakeWindow);
	const events: Array<{ channel: string; payload: unknown }> = [];
	manager = new TaskManager((emit, owner) => new AgentService(fakeWindow, config, inspector, undefined, { emit, owner }),
		(channel, payload) => { events.push({ channel, payload }); });
	const runtime = await manager.owner.getModelRuntime();
	runtime.registerProvider("nekocode-lan-test", {
		name: "Local test model", api: "openai-completions", apiKey: "local-test-only", baseUrl: `http://127.0.0.1:${modelPort}/v1`,
		models: [{ id: "lan-test", name: "LAN test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	await manager.owner.setModel("nekocode-lan-test/lan-test");
	manager.owner.setMode("read-only");
	const desktop = await manager.create(workspace);
	assert((await desktop.send({ text: "验证桌面任务的并行执行。" })).accepted);
	await until(() => !!desktop.getSnapshot()?.streaming, "desktop streaming");
	lan = new LanService(testDir, manager);
	const status = await lan.start(preview ? 47834 : 0);
	const lanPort = (lan as unknown as { server: { address(): { port: number } } }).server.address().port;
	const base = `http://127.0.0.1:${lanPort}`;
	const scanned = parseLanPairing(encodeLanPairing(base, status.pairing!));
	const paired = await fetch(scanned.endpoint + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: scanned.code, name: "Integration test" }) });
	const { token } = await paired.json();
	const project = lan.addProject(workspace).projects[0];
	const response = await fetch(base + "/api/tasks", {
		method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ text: "验证手机创建独立任务并同步到桌面。", projectId: project.id, requestId: "integration-task-0001" }),
	});
	const mobile = await response.json();
	assert.equal(mobile.accepted, true, JSON.stringify(mobile));
	const phone = await manager.byId(mobile.id);
	assert.equal(manager.active, desktop, "Phone creation must not change desktop selection");
	assert.notEqual(phone, desktop);
	assert.equal(await phone.getModelRuntime(), runtime, "Every session must share the model runtime");
	await until(() => !!phone.getSnapshot()?.streaming, "phone streaming");
	assert(desktop.getSnapshot()?.streaming, "Desktop must keep running");
	assert.equal((await manager.list()).filter((s) => s.running).length, 2);
	await manager.open(phone.getSnapshot()!.session);
	assert.equal(manager.active, phone);
	assert(desktop.getSnapshot()?.streaming, "Selecting phone task must not stop desktop task");
	await until(() => !desktop.getSnapshot()?.streaming && !phone.getSnapshot()?.streaming, "both tasks complete");
	for (const agent of [desktop, phone]) {
		assert(agent.getSnapshot()!.cells.some((c) => c.type === "assistant" && c.text.includes("已完成本地测试")));
		assert(!agent.getSnapshot()!.error);
		assert(existsSync(agent.getSnapshot()!.session.sessionFile), "Completed tasks must be persisted");
	}
	assert(peak >= 2);
	assert(events.some((e) => e.channel === "agent:sessionsChanged"));
	console.log("PASS: actual Electron + PI sessions run concurrently, share runtime, persist, and appear on desktop through LAN creation.");
	if (preview) {
		const pairing = lan.newPairing().pairing!;
		console.log(`PREVIEW ${base} CODE ${pairing.code}`);
	} else {
		await lan.stop(); manager.close(); model.closeAllConnections(); model.close(); app.quit();
	}
}).catch(async (error) => {
	console.error(error); await lan?.stop(); manager?.close(); model.closeAllConnections(); model.close(); app.exit(1);
});
