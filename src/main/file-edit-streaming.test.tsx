import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CellProjector, type ProjectableMessage, type ProjectionEvent } from "./agent-projection";
import { Agent } from "@earendil-works/pi-agent-core";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const previousWindow = globalThis.window;
Object.defineProperty(globalThis, "window", { configurable: true, value: { nekocode: {} } });
const { Transcript } = await import("../renderer/src/components/Transcript");
const { I18nProvider } = await import("../renderer/src/i18n");
Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });

const user: ProjectableMessage = { role: "user", content: "Update the file", timestamp: Date.now() - 1000 };
const timestamp = Date.now();
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const message = (...content: unknown[]): ProjectableMessage => ({ role: "assistant", content, timestamp });
const toolCells = (p: CellProjector) => p.cells().filter((cell) => cell.type === "tool");
const render = (p: CellProjector, streaming = true) => renderToStaticMarkup(
	createElement(I18nProvider, {
		children: createElement(Transcript, { cells: p.cells(), streaming }),
	}),
);

describe("file edits follow streamed tool input", () => {
	test.each(["edit", "write"] as const)("%s renders from toolcall_start through real provider deltas with path last", async (name) => {
		const p = new CellProjector();
		const model: Model<"openai-completions"> = {
			id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture",
			baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
		};
		const args = name === "edit"
			? { edits: [{ oldText: "before", newText: "first\nsecond" }], path: "notes.md" }
			: { content: "first\nsecond", path: "notes.md" };
		// Split inside a JSON string, and deliberately withhold the path until
		// the last delta, just as the observed GLM calls do.
		const deltas = name === "edit"
			? ['{"edits":[{"oldText":"before","newText":"first\\nsec', 'ond"}]', ',"path":"notes.md"}']
			: ['{"content":"first\\nsec', 'ond"', ',"path":"notes.md"}'];
		const encoder = new TextEncoder();
		const chunk = (delta: unknown, finish_reason: string | null = null) => encoder.encode(`data: ${JSON.stringify({
			id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
			choices: [{ index: 0, delta, finish_reason }],
		})}\n\n`);
		let controller: ReadableStreamDefaultController<Uint8Array>;
		let requests = 0;
		const fetchFixture = (async () => {
			requests++;
			if (requests > 1) return new Response(new ReadableStream({ start(c) {
				c.enqueue(chunk({ role: "assistant", content: "Done" }, "stop"));
				c.enqueue(encoder.encode("data: [DONE]\n\n"));
				c.close();
			} }), { headers: { "content-type": "text/event-stream" } });
			return new Response(new ReadableStream({ start(c) {
				controller = c;
				c.enqueue(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "file-call", type: "function", function: { name, arguments: "" } }] }));
			} }), { headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		let executed = false;
		const agent = new Agent({
			initialState: { model, tools: [{
				name, label: name, description: "Change a file",
				parameters: name === "edit"
					? Type.Object({ edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })), path: Type.String() })
					: Type.Object({ content: Type.String(), path: Type.String() }),
				execute: async (_id, actual) => {
					expect(actual).toEqual(args);
					executed = true;
					return { content: [{ type: "text", text: "Applied" }], details: {} };
				},
			}] },
			streamFn: (_model, context, options) => streamOpenAICompletions(model, context, { ...options, apiKey: "fixture", fetch: fetchFixture }),
		});
		const frames: { html: string; executed: boolean; id: string | undefined }[] = [];
		let nextDelta = 0;
		agent.subscribe((event) => {
			p.handleEvent(event as ProjectionEvent);
			p.rebuild(agent.state.messages, agent.state.isStreaming);
			if (event.type !== "message_update") return;
			const kind = event.assistantMessageEvent.type;
			if (kind !== "toolcall_start" && kind !== "toolcall_delta") return;
			if (event.assistantMessageEvent.type === "toolcall_delta" && !event.assistantMessageEvent.delta) return;
			frames.push({ html: render(p), executed, id: toolCells(p)[0]?.id });
			// Release the next network chunk only after the current one has made
			// it through the real provider parser and agent event loop to the UI.
			if (nextDelta < deltas.length) {
				controller.enqueue(chunk({ tool_calls: [{ index: 0, function: { arguments: deltas[nextDelta++] } }] }));
			} else {
				controller.enqueue(chunk({}, "tool_calls"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			}
		});
		await agent.prompt("Change the file");
		expect(agent.state.messages.filter((m) => m.role === "assistant" && m.errorMessage).map((m) => m.role === "assistant" && m.errorMessage)).toEqual([]);
		expect(executed).toBe(true);
		expect(frames).toHaveLength(4);
		for (const frame of frames) {
			expect(frame.executed).toBe(false);
			expect(frame.id).toBe("tool-file-call");
			expect(frame.html).toContain('data-file-edit="file-call"');
			expect(frame.html).toContain("正在生成修改");
		}
		expect(frames[0].html).toContain("等待修改内容");
		expect(frames[1].html).toContain("first");
		expect(frames[1].html).toContain("sec");
		expect(frames[1].html).not.toContain("second");
		expect(frames[2].html).toContain("second");
		expect(frames[2].html).not.toContain("notes.md");
		expect(frames[3].html).toContain("notes.md");
	});

	test("write shows every received line and updates a partial last line before execution", () => {
		const p = new CellProjector();
		p.rebuild([user], true);
		const update = (args: unknown) => {
			p.handleEvent({ type: "message_update", message: message(call("write-1", "write", args)) });
			// The live message is not yet in session.messages.
			p.rebuild([user], true);
		};
		update({ path: "notes.md" });
		expect(render(p)).toContain("notes.md");
		expect(render(p)).toContain("正在生成修改");
		update({ path: "notes.md", content: "first\nsec" });
		const html = render(p);
		expect(html).toContain("first");
		expect(html).toContain("sec");
		expect(html).not.toContain("second");
		expect(html).not.toContain("Planning Next Step");
		const id = toolCells(p)[0].id;
		update({ path: "notes.md", content: "first\nsecond" });
		expect(toolCells(p)).toHaveLength(1);
		expect(toolCells(p)[0]).toMatchObject({ id, status: "pending", inputStreaming: true });
		expect(render(p)).toContain("second");
	});

	test("multiple edits tolerate incomplete array entries and render only received text", () => {
		const p = new CellProjector();
		p.rebuild([user], true);
		p.handleEvent({
			type: "message_update",
			message: message(call("edit-1", "edit", {
				path: "app.ts", edits: [{ oldText: "before", newText: "after" }, null, {}],
			})),
		});
		const first = render(p);
		expect(first).toContain("before");
		expect(first).toContain("after");
		p.handleEvent({
			type: "message_update",
			message: message(call("edit-1", "edit", {
				path: "app.ts", edits: [{ oldText: "before", newText: "after" }, { oldText: "second old", newText: "second new" }],
			})),
		});
		expect(render(p)).toContain("second new");
		expect(toolCells(p)).toHaveLength(1);
	});

	test("generation, execution, and the persisted diff share one card", () => {
		const p = new CellProjector();
		const args = { path: "app.ts", oldText: "old", newText: "new\nlast" };
		const input = message(call("edit-1", "edit", args));
		p.handleEvent({ type: "message_update", message: input });
		p.rebuild([user], true);
		const id = toolCells(p)[0].id;
		p.handleEvent({ type: "message_end", message: input });
		p.rebuild([user, input], true);
		expect(toolCells(p)).toHaveLength(1);
		expect(toolCells(p)[0].inputStreaming).toBeUndefined();
		expect(render(p)).toContain("等待应用");
		expect(render(p)).toContain("last");
		p.handleEvent({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args });
		expect(render(p)).toContain("正在应用修改");
		const details = { diff: " 1 surrounding context\n-2 old\n+2 new\n+3 last" };
		p.handleEvent({ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", result: { details }, isError: false });
		expect(render(p)).toContain("surrounding context");
		expect(render(p)).toContain("last");
		p.rebuild([user, input, { role: "toolResult", toolCallId: "edit-1", toolName: "edit", details }], false);
		expect(toolCells(p)).toHaveLength(1);
		expect(toolCells(p)[0]).toMatchObject({ id, status: "done", details });
		expect(render(p, false)).not.toContain("正在生成修改");
	});

	test("complete input arriving in one chunk is visible immediately during an active turn", () => {
		const p = new CellProjector();
		const input = message(call("write-1", "write", { path: "notes.md", content: "one\ntwo\nthree" }));
		p.handleEvent({ type: "message_end", message: input });
		p.rebuild([user, input], true);
		const html = render(p);
		for (const line of ["one", "two", "three"]) expect(html).toContain(line);
		expect(html).not.toContain("chat-message-send-enter");
	});

	test("interleaved tool calls retain their ids and order without duplicates", () => {
		const p = new CellProjector();
		const first = call("write-1", "write", { path: "a.md", content: "a" });
		p.handleEvent({ type: "message_update", message: message(first) });
		const second = call("edit-2", "edit", { path: "b.md", newText: "b" });
		for (let i = 0; i < 3; i++) {
			p.handleEvent({ type: "message_update", message: message(first, second) });
			p.rebuild([user], true);
		}
		expect(toolCells(p).map((c) => c.toolCallId)).toEqual(["write-1", "edit-2"]);
		p.handleEvent({ type: "message_end", message: message(first, second) });
		p.rebuild([user, message(first, second)], true);
		expect(toolCells(p).map((c) => c.toolCallId)).toEqual(["write-1", "edit-2"]);
		expect(toolCells(p).every((c) => !c.inputStreaming)).toBe(true);
	});

	test.each(["error", "aborted"])("%s during generation never leaves a successful diff or a pending preview", (stopReason) => {
		const p = new CellProjector();
		const partial = message(call("write-1", "write", { path: "notes.md", content: "unfinished" }));
		p.handleEvent({ type: "message_update", message: partial });
		const failed = { ...partial, stopReason, errorMessage: "Interrupted" };
		p.handleEvent({ type: "message_end", message: failed });
		p.rebuild([user, failed], false);
		expect(toolCells(p)).toHaveLength(1);
		expect(toolCells(p)[0]).toMatchObject({ status: "error", output: "Interrupted" });
		expect(toolCells(p)[0].inputStreaming).toBeUndefined();
		expect(render(p, false)).not.toContain("正在生成修改");
		expect(render(p, false)).not.toContain("bg-[color-mix(in_srgb,var(--success)");
	});

	test.each(["agent_end", "agent_settled"] as const)("%s discards input previews even without message_end", (type) => {
		const p = new CellProjector();
		p.handleEvent({ type: "message_update", message: message(call("w", "write", { path: "a", content: "partial" })) });
		p.handleEvent({ type });
		p.rebuild([user]);
		expect(toolCells(p)).toHaveLength(0);
	});
});
