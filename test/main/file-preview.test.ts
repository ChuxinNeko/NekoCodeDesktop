import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewReferencedFile } from "../../src/main/file-preview";
import { resolveUnderRoot } from "../../src/main/project-paths";
import { FS_READ_MAX_BYTES } from "../../src/shared/files";

test("external references preview read-only without widening the project root", async () => {
 const dir = await mkdtemp(join(tmpdir(),"neko-preview-"));
 try {
  const root = join(dir,"project"); await mkdir(root);
  const outside = join(dir,"template.html"); await writeFile(outside,"<html>template</html>");
  expect(await previewReferencedFile(root,outside)).toMatchObject({kind:"text",external:true,text:"<html>template</html>",relPath:outside});
  expect(() => resolveUnderRoot(root,outside)).toThrow("Path escapes project root");
  await expect(previewReferencedFile(root,"../template.html")).rejects.toThrow("Path escapes project root");
  await writeFile(join(root,"local.txt"),"local");
  expect(await previewReferencedFile(root,"local.txt")).toMatchObject({external:false,relPath:"local.txt",text:"local"});
  await expect(previewReferencedFile(root,dir)).rejects.toThrow("Not a file");
  await writeFile(outside,"x".repeat(FS_READ_MAX_BYTES+10));
  const large = await previewReferencedFile(root,outside);
  expect(large.kind).toBe("text");
  if(large.kind === "text") { expect(large.truncated).toBe(true); expect(large.text.length).toBe(FS_READ_MAX_BYTES); }
 } finally { await rm(dir,{recursive:true,force:true}); }
});
