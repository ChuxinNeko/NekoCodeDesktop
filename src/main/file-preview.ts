import { open } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { FS_IMAGE_MAX_BYTES, FS_IMAGE_MIME, FS_READ_MAX_BYTES, type FsReadResult } from "../shared/files";
import { resolveUnderRoot } from "./project-paths";

/** Desktop-only, read-only preview of an explicitly clicked file reference.
 * Relative paths remain project-bound; external files must be named absolutely.
 * This endpoint does not grant directory navigation or editor/write access.
 */
export async function previewReferencedFile(cwd: string, path: string): Promise<FsReadResult & { external: boolean }> {
 let target: string, label: string, external = false;
 try {
  const resolved = resolveUnderRoot(cwd, path);
  target = resolved.target; label = resolved.relPath;
 } catch (error) {
  if (!isAbsolute(path)) throw error;
  target = resolve(path); label = target; external = true;
 }
 const handle = await open(target, "r");
 try {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  const mime = FS_IMAGE_MIME[extname(target).slice(1).toLowerCase()];
  if (mime && info.size > FS_IMAGE_MAX_BYTES) return {kind:"binary",relPath:label,size:info.size,external};
  const buffer = Buffer.alloc(Math.min(info.size, mime ? FS_IMAGE_MAX_BYTES : FS_READ_MAX_BYTES));
  let length = 0;
  while (length < buffer.length) {
   const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
   if (!bytesRead) break;
   length += bytesRead;
  }
  const content = buffer.subarray(0,length);
  if (mime) return {kind:"image",relPath:label,dataUrl:`data:${mime};base64,${content.toString("base64")}`,size:info.size,external};
  if (content.includes(0)) return {kind:"binary",relPath:label,size:info.size,external};
  return {kind:"text",relPath:label,text:content.toString("utf8"),truncated:info.size > length,external};
 } finally { await handle.close(); }
}
