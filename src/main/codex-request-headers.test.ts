import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from "./openai-codex";
import { registerOAuthClientIdentity } from "./oauth-service";

const roots: string[] = [];

function agentHome(credential: Record<string, unknown>): string {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "nekocode-codex-headers-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": credential }), { mode: 0o600 });
	return agentDir;
}

afterEach(() => {
	const tempRoot = realpathSync(tmpdir());
	for (const root of roots.splice(0)) {
		const target = realpathSync(root);
		if (!target.startsWith(resolve(tempRoot) + sep) || !basename(target).startsWith("nekocode-codex-headers-")) {
			throw new Error("Refusing unsafe test cleanup");
		}
		rmSync(target, { recursive: true, force: true });
	}
});

function accessToken(accountId: string): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return [
		encode({ alg: "none" }),
		encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" } }),
		"signature",
	].join(".");
}

const COMPLETED_SSE = `data: ${JSON.stringify({
	type: "response.completed",
	response: {
		status: "completed",
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
	},
})}\n\n`;

/**
 * What the ChatGPT Codex backend actually receives.
 *
 * The client identity is pinned through several layers the app does not own —
 * provider registration, the core's OAuth auth resolution, and the codex API's
 * own header defaults — so it is asserted on the wire rather than at the point
 * it is configured. A request that goes out as this app instead of as the Codex
 * CLI is what gets a subscription flagged.
 */
describe("codex upstream headers", () => {
	test("go out as the Codex CLI, over the agent core's own defaults", async () => {
		const agentDir = agentHome({
			type: "oauth",
			access: accessToken("acc_wire"),
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "acc_wire",
		});
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
		});
		registerOAuthClientIdentity(runtime);
		const model = runtime.getModel("openai-codex", "gpt-5.5");
		if (!model) throw new Error("openai-codex/gpt-5.5 is not a registered model");

		let seen: Headers | undefined;
		let url: string | undefined;
		await runtime
			.stream(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, {
				transport: "sse",
				fetch: async (input: string | URL | Request, init?: RequestInit) => {
					url = typeof input === "string" ? input : input.toString();
					seen = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
					return new Response(COMPLETED_SSE, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			} as Parameters<typeof runtime.stream>[2])
			.result();

		expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(seen?.get("User-Agent")).toBe(CODEX_USER_AGENT);
		expect(seen?.get("originator")).toBe(CODEX_ORIGINATOR);
		// Neither the app's nor the core's own product token reaches this endpoint.
		expect(seen?.get("User-Agent")).not.toContain("nekocode");
		expect(seen?.get("originator")).not.toContain("nekocode");
		// The credential the core resolved, unchanged by the pin.
		expect(seen?.get("Authorization")).toBe(`Bearer ${accessToken("acc_wire")}`);
		expect(seen?.get("chatgpt-account-id")).toBe("acc_wire");
	});

	test("without the pin the core would send its own identity", async () => {
		// The inverse of the case above: it is the registration that does it, so a
		// future change that drops it fails here instead of silently going out.
		const agentDir = agentHome({
			type: "oauth",
			access: accessToken("acc_bare"),
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "acc_bare",
		});
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const model = runtime.getModel("openai-codex", "gpt-5.5");
		if (!model) throw new Error("openai-codex/gpt-5.5 is not a registered model");

		let seen: Headers | undefined;
		await runtime
			.stream(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, {
				transport: "sse",
				fetch: async (_input: string | URL | Request, init?: RequestInit) => {
					seen = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
					return new Response(COMPLETED_SSE, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			} as Parameters<typeof runtime.stream>[2])
			.result();

		expect(seen?.get("originator")).toBe("nekocode");
	});
});
