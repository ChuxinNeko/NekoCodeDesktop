import { expect, test } from "bun:test";
import { formatAntigravityError, readAntigravityErrorBody, redactAntigravityError } from "./antigravity-error";

test("preserves Google error status, message and structured details", async () => {
	const body = { error: { code: 403, status: "PERMISSION_DENIED", message: "This account is not eligible for this service", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { service: "cloudcode-pa.googleapis.com" } }] } };
	const raw = await readAntigravityErrorBody(Response.json(body, { status: 403 }));
	const error = formatAntigravityError("Antigravity 请求失败（HTTP 403）", raw);
	expect(error).toContain(JSON.stringify(body, null, 2));
});

test("redacts nested token fields and reflected credentials while keeping JSON readable", () => {
	const raw = JSON.stringify({ error: { message: "Rejected secret-access (Bearer other-token)", details: [{ refresh_token: "refresh-secret", accessToken: "access-secret", authorization: "Basic secret" }], reason: "ACCOUNT_RESTRICTED" } });
	const result = redactAntigravityError(raw, ["secret-access"]);
	for (const secret of ["secret-access", "other-token", "refresh-secret", "access-secret", "Basic secret"]) expect(result).not.toContain(secret);
	expect(JSON.parse(result).error.reason).toBe("ACCOUNT_RESTRICTED");
	expect(result).toContain("[REDACTED]");
});

test("retains plain text/HTML diagnostics and handles empty bodies", async () => {
	const raw = "<html><h1>Access denied by gateway</h1></html>\ntrace=abc";
	expect(formatAntigravityError("HTTP 403", raw)).toContain(raw);
	expect(formatAntigravityError("HTTP 403", "")).toContain("空响应正文");
	expect(redactAntigravityError("reason=disabled&access_token=private&trace=abc")).toBe("reason=disabled&access_token=[REDACTED]&trace=abc");
	expect(await readAntigravityErrorBody(new Response(null, { status: 403 }))).toBe("");
});

test("bounds error body reads and marks truncation", async () => {
	let cancelled = false;
	const response = new Response(new ReadableStream({
		start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(70 * 1024))); },
		cancel() { cancelled = true; },
	}));
	const body = await readAntigravityErrorBody(response);
	expect(body).toStartWith("x".repeat(64 * 1024));
	expect(body).toContain("已截断");
	expect(cancelled).toBe(true);
});
