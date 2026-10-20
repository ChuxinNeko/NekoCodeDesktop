import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("capability fetch persists metadata, honors manual overrides and rejects stale endpoint results", async () => {
	const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/model-config-capabilities.ts", import.meta.url))],
		{ stdout: "pipe", stderr: "pipe" });
	const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ code, error }).toEqual({ code: 0, error: "" });
	expect(output).toContain("model capability service integration passed");
}, 30000);
