import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskManager } from "../../src/main/task-manager";
import { LanService } from "../../src/main/lan-service";
import { MobileUploads, safeFileName, UPLOAD_CHUNK_BYTES } from "../../src/main/mobile-uploads";

const dirs: string[] = [];
const services: LanService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "nekocode-upload-test-")); dirs.push(dir); return dir; };

function upload(store: MobileUploads, owner: string, name: string, mimeType: string, bytes: Buffer) {
	const { id, chunks, chunkSize } = store.start(owner, { name, mimeType, size: bytes.length });
	for (let index = 0; index < chunks; index++) {
		store.chunk(owner, id, { index, data: bytes.subarray(index * chunkSize, (index + 1) * chunkSize).toString("base64") });
	}
	return id;
}

describe("mobile uploads", () => {
	test("multi-chunk image becomes a prompt image, other files are saved in a self-ignoring folder", async () => {
		const store = new MobileUploads();
		const cwd = tempDir();
		const image = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 17, 7);
		const pdf = Buffer.from("%PDF-1.4 hello");
		const a = upload(store, "phone", "photo.jpg", "image/jpeg", image);
		const b = upload(store, "phone", "../../etc/报告?.pdf", "application/pdf", pdf);
		const c = upload(store, "phone", "报告?.pdf", "application/pdf", pdf);
		const resolved = await store.resolve("phone", [a, b, c], cwd, { images: true });
		expect(resolved.images).toHaveLength(1);
		expect(Buffer.from(resolved.images[0].data, "base64").equals(image)).toBe(true);
		expect(resolved.files).toHaveLength(2);
		expect(resolved.files[0]).toMatch(/^\.nekocode\/uploads\/[^/]+\/报告_\.pdf$/);
		expect(resolved.files[1]).toMatch(/报告_-2\.pdf$/);
		expect(readFileSync(join(cwd, resolved.files[0]), "utf8")).toBe("%PDF-1.4 hello");
		expect(readFileSync(join(cwd, ".nekocode", "uploads", ".gitignore"), "utf8")).toBe("*\n");
	});

	test("rejects incomplete, foreign, oversized and malformed uploads", async () => {
		const store = new MobileUploads();
		const { id } = store.start("phone", { name: "a.png", mimeType: "image/png", size: UPLOAD_CHUNK_BYTES + 1 });
		store.chunk("phone", id, { index: 0, data: Buffer.alloc(UPLOAD_CHUNK_BYTES).toString("base64") });
		// Retrying a chunk is harmless.
		expect(store.chunk("phone", id, { index: 0, data: Buffer.alloc(UPLOAD_CHUNK_BYTES).toString("base64") }).received).toBe(1);
		await expect(store.resolve("phone", [id], tempDir(), { images: true })).rejects.toThrow("尚未上传完成");
		await expect(store.resolve("other", [id], tempDir(), { images: true })).rejects.toThrow("已过期");
		expect(() => store.chunk("phone", id, { index: 1, data: "AAAA" })).toThrow("大小不符");
		expect(() => store.chunk("phone", id, { index: 2, data: "AA==" })).toThrow("编号无效");
		expect(() => store.chunk("phone", id, { index: 1, data: "not base64!" })).toThrow("base64");
		expect(() => store.start("phone", { name: "big.bin", size: 11 * 1024 * 1024 })).toThrow("不能超过");
		expect(() => store.start("phone", { name: "", size: 1 })).toThrow("文件名");
	});

	test("expired uploads are gone; images can be forced to files", async () => {
		let now = 1_000;
		const store = new MobileUploads(() => now);
		const id = upload(store, "phone", "a.png", "image/png", Buffer.from("png"));
		const cwd = tempDir();
		const asFile = await store.resolve("phone", [id], cwd, { images: false });
		expect(asFile.images).toHaveLength(0);
		expect(asFile.files[0]).toMatch(/a\.png$/);
		now += 31 * 60_000;
		await expect(store.resolve("phone", [id], cwd, { images: true })).rejects.toThrow("已过期");
		expect(safeFileName("con<>.txt")).toBe("con_.txt");
	});

	test("LAN and relay: chunks upload, a message carries them and empty text is allowed", async () => {
		const dir = tempDir();
		const prompts: unknown[] = [];
		const tasks = {
			list: async () => [],
			create: async () => ({ getSnapshot: () => ({ session: { id: "phone-task", cwd: dir } }),
				send: async (prompt: unknown) => { prompts.push(prompt); return { accepted: true }; } }),
			byId: async () => ({ getSnapshot: () => ({ session: { id: "t", cwd: dir } }),
				send: async (prompt: unknown) => { prompts.push(prompt); return { accepted: true }; } }),
		} as unknown as TaskManager;
		const service = new LanService(dir, tasks);
		services.push(service);
		await service.start(0);
		const project = service.addProject(dir);
		const port = (service as unknown as { server: { address(): { port: number } } }).server.address().port;
		const url = `http://127.0.0.1:${port}`;
		const post = async (path: string, body: unknown, token?: string) => {
			const res = await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
			return { status: res.status, body: await res.json() };
		};
		const token = (await post("/api/pair", { code: service.status().pairing!.code, name: "phone" })).body.token as string;
		const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES + 5, 1);
		const started = await post("/api/uploads", { name: "shot.png", mimeType: "image/png", size: bytes.length }, token);
		expect(started.status).toBe(200);
		const id = started.body.id as string;
		// A full chunk (~700 KiB of base64) passes the LAN body limit.
		expect((await post(`/api/uploads/${id}/chunk`, { index: 0, data: bytes.subarray(0, UPLOAD_CHUNK_BYTES).toString("base64") }, token)).status).toBe(200);
		// Unfinished: refused, and the same request may be retried once complete.
		const message = { projectId: project.projects.at(-1)!.id, text: "", attachments: [id], requestId: "req-0000000000000001" };
		expect((await post("/api/tasks", message, token)).status).toBe(409);
		expect((await post(`/api/uploads/${id}/chunk`, { index: 1, data: bytes.subarray(UPLOAD_CHUNK_BYTES).toString("base64") }, token)).status).toBe(200);
		const created = await post("/api/tasks", message, token);
		expect(created.body).toEqual({ id: "phone-task", accepted: true });
		expect(prompts[0]).toMatchObject({ text: "请检查所附图片。", images: [{ name: "shot.png", mimeType: "image/png" }] });
		// Released once accepted.
		expect((await post(`/api/uploads/${id}/chunk`, { index: 0, data: "AAAA" }, token)).status).toBe(404);

		// Relay goes through the same dispatcher.
		const relay = (path: string, body: Record<string, unknown>) => service.handleRelay("peer-0000000000000001", { id: `r-${Math.random().toString(16).slice(2).padEnd(16, "0")}`, method: "POST", path, body });
		const text = Buffer.from("console.log(1)");
		const begun = await relay("/api/uploads", { name: "main.ts", mimeType: "text/plain", size: text.length });
		expect(begun.status).toBe(200);
		const fileId = (begun.body as { id: string }).id;
		expect((await relay(`/api/uploads/${fileId}/chunk`, { index: 0, data: text.toString("base64") })).status).toBe(200);
		const sent = await relay("/api/tasks/t/send", { text: "看看这个文件", attachments: [fileId], requestId: "req-0000000000000002" });
		expect(sent).toMatchObject({ status: 200, body: { accepted: true } });
		const prompt = prompts[1] as { text: string; images?: unknown };
		expect(prompt.images).toBeUndefined();
		const saved = /- (\.nekocode\/uploads\/\S+main\.ts)/.exec(prompt.text)![1];
		expect(prompt.text.startsWith("看看这个文件\n\n附件")).toBe(true);
		expect(readFileSync(join(dir, saved), "utf8")).toBe("console.log(1)");
		// Another phone cannot use this phone's upload.
		const lanFile = await post("/api/uploads", { name: "x.txt", size: 1 }, token);
		expect((await relay(`/api/uploads/${lanFile.body.id}/chunk`, { index: 0, data: "eA==" })).status).toBe(404);
	});
});
