import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGE_TOTAL_BYTES,
	MAX_PROMPT_IMAGES,
	type PromptImageAttachment,
} from "../shared/agent";

/**
 * Attachments uploaded from the phone.
 *
 * LAN requests and relay frames are both small (64 KiB JSON bodies; 1 MiB
 * encrypted relay frames), so a file travels as numbered base64 chunks through
 * the ordinary request channel and is assembled here. Nothing touches disk until
 * a message actually uses the upload: images become prompt images, any other
 * file is written into the project's self-ignoring `.nekocode/uploads` folder and
 * referenced by path in the prompt.
 */

/** Raw bytes per chunk: base64 + JSON + AES-GCM stays well under the relay's 1 MiB. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 8;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const TTL_MS = 30 * 60_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_TYPES = new Map([
	["image/png", "image/png"], ["image/jpeg", "image/jpeg"], ["image/jpg", "image/jpeg"],
	["image/webp", "image/webp"], ["image/gif", "image/gif"], ["image/bmp", "image/bmp"],
]);

export class UploadError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

interface Upload {
	id: string;
	owner: string;
	name: string;
	mimeType: string;
	size: number;
	chunks: (Buffer | undefined)[];
	received: number;
	expiresAt: number;
}

export interface ResolvedAttachments {
	images: PromptImageAttachment[];
	/** Project-relative paths of saved non-image files. */
	files: string[];
}

/** A file name safe on every desktop OS, keeping its extension. */
export function safeFileName(name: string): string {
	const base = basename(name.replace(/\\/g, "/")).normalize("NFC");
	const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
	const value = cleaned || "attachment";
	if (value.length <= 120) return value;
	const ext = extname(value).slice(0, 16);
	return value.slice(0, 120 - ext.length) + ext;
}

export class MobileUploads {
	private uploads = new Map<string, Upload>();

	constructor(private now: () => number = Date.now) {}

	private sweep(): void {
		const now = this.now();
		for (const [id, upload] of this.uploads) if (upload.expiresAt <= now) this.uploads.delete(id);
	}

	start(owner: string, input: Record<string, unknown>): { id: string; chunkSize: number; chunks: number } {
		this.sweep();
		const name = typeof input.name === "string" ? input.name.trim() : "";
		if (!name || name.length > 255) throw new UploadError(400, "附件文件名无效");
		const size = input.size;
		if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) throw new UploadError(400, "附件大小无效");
		if (size > MAX_UPLOAD_BYTES) throw new UploadError(413, `单个附件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB`);
		const rawType = typeof input.mimeType === "string" ? input.mimeType.trim().toLowerCase() : "";
		if (rawType.length > 120) throw new UploadError(400, "附件类型无效");
		const pending = [...this.uploads.values()].filter((u) => u.owner === owner).reduce((sum, u) => sum + u.size, 0);
		if (pending + size > MAX_PENDING_BYTES) throw new UploadError(429, "待发送的附件过多，请先发送或稍后再试");
		const chunks = Math.ceil(size / UPLOAD_CHUNK_BYTES);
		const id = randomUUID();
		this.uploads.set(id, {
			id, owner, name, size, mimeType: rawType || "application/octet-stream",
			chunks: new Array(chunks).fill(undefined), received: 0, expiresAt: this.now() + TTL_MS,
		});
		return { id, chunkSize: UPLOAD_CHUNK_BYTES, chunks };
	}

	private get(owner: string, id: string): Upload {
		this.sweep();
		const upload = this.uploads.get(id);
		if (!upload || upload.owner !== owner) throw new UploadError(404, "附件已过期，请重新添加");
		return upload;
	}

	/** Idempotent per index, so a chunk retried after a lost reply is harmless. */
	chunk(owner: string, id: string, input: Record<string, unknown>): { received: number; complete: boolean } {
		const upload = this.get(owner, id);
		const index = input.index;
		if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= upload.chunks.length) {
			throw new UploadError(400, "附件分片编号无效");
		}
		const data = input.data;
		if (typeof data !== "string" || !data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
			throw new UploadError(400, "附件分片不是有效的 base64");
		}
		const bytes = Buffer.from(data, "base64");
		const last = index === upload.chunks.length - 1;
		const expected = last ? upload.size - index * UPLOAD_CHUNK_BYTES : UPLOAD_CHUNK_BYTES;
		if (bytes.length !== expected) throw new UploadError(400, "附件分片大小不符");
		if (!upload.chunks[index]) {
			upload.chunks[index] = bytes;
			upload.received++;
		}
		upload.expiresAt = this.now() + TTL_MS;
		return { received: upload.received, complete: upload.received === upload.chunks.length };
	}

	cancel(owner: string, id: string): void {
		const upload = this.uploads.get(id);
		if (upload?.owner === owner) this.uploads.delete(id);
	}

	/** Validates every id first so a bad list never half-writes files. */
	async resolve(owner: string, ids: unknown, cwd: string, options: { images: boolean }): Promise<ResolvedAttachments> {
		if (ids === undefined) return { images: [], files: [] };
		if (!Array.isArray(ids) || ids.length > MAX_MESSAGE_ATTACHMENTS || ids.some((id) => typeof id !== "string")) {
			throw new UploadError(400, `一次最多发送 ${MAX_MESSAGE_ATTACHMENTS} 个附件`);
		}
		const uploads = [...new Set(ids as string[])].map((id) => this.get(owner, id));
		for (const upload of uploads) if (upload.received !== upload.chunks.length) throw new UploadError(409, `「${upload.name}」尚未上传完成`);
		const images: PromptImageAttachment[] = [];
		const files: Upload[] = [];
		let imageBytes = 0;
		for (const upload of uploads) {
			const mime = IMAGE_TYPES.get(upload.mimeType);
			const fitsImage = options.images && mime && upload.size <= MAX_PROMPT_IMAGE_BYTES &&
				images.length < MAX_PROMPT_IMAGES && imageBytes + upload.size <= MAX_PROMPT_IMAGE_TOTAL_BYTES;
			if (fitsImage) {
				imageBytes += upload.size;
				images.push({ name: upload.name, mimeType: mime, data: Buffer.concat(upload.chunks as Buffer[]).toString("base64") });
			} else files.push(upload);
		}
		const saved: string[] = [];
		if (files.length) {
			const stamp = new Date(this.now()).toISOString().slice(0, 19).replace(/[-:T]/g, "");
			const folder = `${stamp}-${randomUUID().slice(0, 8)}`;
			const root = join(cwd, ".nekocode", "uploads");
			await mkdir(join(root, folder), { recursive: true });
			// The folder ignores itself: phone uploads never end up in a commit.
			await writeFile(join(root, ".gitignore"), "*\n", { flag: "w" });
			const used = new Set<string>();
			for (const upload of files) {
				const original = safeFileName(upload.name);
				const ext = extname(original);
				const stem = ext ? original.slice(0, -ext.length) : original;
				let name = original;
				for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
				used.add(name.toLowerCase());
				await writeFile(join(root, folder, name), Buffer.concat(upload.chunks as Buffer[]));
				saved.push(`.nekocode/uploads/${folder}/${name}`);
			}
		}
		return { images, files: saved };
	}

	/** Called once the message that used them was accepted. */
	release(owner: string, ids: unknown): void {
		if (!Array.isArray(ids)) return;
		for (const id of ids) if (typeof id === "string") this.cancel(owner, id);
	}
}

/** Prompt text that points the agent at saved files. */
export function withAttachedFiles(text: string, files: string[], fallback: string): string {
	const body = text.trim() ? text : fallback;
	if (!files.length) return body;
	return `${body}\n\n附件（已保存到项目中）：\n${files.map((file) => `- ${file}`).join("\n")}`;
}
