import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { ComposerQueue } from "../../../../src/renderer/src/components/chat/ComposerQueue";
import { ComposerShell } from "../../../../src/renderer/src/components/chat/ComposerShell";
import {
	emptyComposerQueue,
	enqueueComposerPrompt,
	queuedPromptAfterTransition,
	removeComposerPrompt,
} from "../../../../src/renderer/src/components/chat/useComposerQueue";

const noop = () => {};
type WindowStub = { matchMedia?: Window["matchMedia"] };
const globalScope = globalThis as unknown as { window?: WindowStub };
const media = (query: string) => ({
	matches: false, media: query, onchange: null,
	addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop,
	dispatchEvent: () => false,
});
const withBrowserStubs = (render: () => string): string => {
	const previousWindow = globalScope.window;
	const previousMatchMedia = previousWindow?.matchMedia;
	if (!previousWindow) globalScope.window = { matchMedia: media };
	else previousWindow.matchMedia = media;
	try {
		return render();
	} finally {
		if (previousWindow) {
			if (previousMatchMedia) previousWindow.matchMedia = previousMatchMedia;
			else delete previousWindow.matchMedia;
		} else {
			delete globalScope.window;
		}
	}
};
const renderShell = (streaming: boolean) => withBrowserStubs(() => renderToStaticMarkup(
	<I18nProvider>
		<ComposerShell draft="下一条消息" onDraftChange={noop} disabled={false} streaming={streaming}
			queueScope="session-a" onSend={noop} onAbort={noop} />
	</I18nProvider>,
));

describe("ComposerShell queued follow-ups", () => {
	test("a running composer keeps the draft editable and offers queue and stop actions without interruption", () => {
		const html = renderShell(true);

		expect(html).toContain('data-composer-control="queue"');
		expect(html).not.toContain('data-composer-control="interrupt"');
		expect(html).toContain('data-composer-control="stop"');
		expect(html).not.toContain('data-composer-control="submit"');
		expect(html).toContain("下一条消息");
		expect(html).not.toContain("<textarea disabled");
	});

	test("an idle composer sends directly instead of showing a queue action", () => {
		const html = renderShell(false);

		expect(html).toContain('data-composer-control="submit"');
		expect(html).not.toContain('data-composer-control="queue"');
	});

	test("queued rows expose non-interrupting steer and remove actions", () => {
		const html = renderToStaticMarkup(<I18nProvider>
			<ComposerQueue items={[{ id: 1, request: { text: "先发送我" } }]} streaming={true}
				canSteer={true} sendingId={null} onSendNow={noop} onRemove={noop} />
		</I18nProvider>);

		expect(html).toContain('data-composer-queued-message="1"');
		expect(html).toContain("先发送我");
		expect(html).toContain("引导");
		expect(html).not.toContain("打断并发送");
		expect(html).toContain("移除待发送消息");
	});

	test("agents without steering keep messages queued without offering an interrupt action", () => {
		const html = renderToStaticMarkup(<I18nProvider>
			<ComposerQueue items={[{ id: 1, request: { text: "wait" } }]} streaming={true}
				canSteer={false} sendingId={null} onSendNow={noop} onRemove={noop} />
		</I18nProvider>);
		expect(html).not.toContain("引导当前工作");
		expect(html).not.toContain("打断并发送");
		expect(html).toContain("wait");
	});

	test("failed delivery leaves the row available and displays the failure", () => {
		const html = renderToStaticMarkup(<I18nProvider>
			<ComposerQueue items={[{ id: 1, request: { text: "retry me" } }]} streaming={false}
				canSteer={false} sendingId={null} error="delivery failed" onSendNow={noop} onRemove={noop} />
		</I18nProvider>);
		expect(html).toContain("retry me");
		expect(html).toContain('role="alert"');
		expect(html).toContain("delivery failed");
	});
});

describe("composer queue ordering", () => {
	test("only a finished run dispatches the oldest row, preventing idle rerender duplicates", () => {
		const items = [{ id: 1, request: { text: "first" } }, { id: 2, request: { text: "second" } }];

		const finished = queuedPromptAfterTransition(true, false, items);
		const idleRerender = queuedPromptAfterTransition(false, false, items);
		const stillRunning = queuedPromptAfterTransition(true, true, items);

		expect(finished).toEqual(items[0]);
		expect(idleRerender).toBeNull();
		expect(stillRunning).toBeNull();
	});

	test("enqueue preserves request attachments and FIFO order", () => {
		const first = { text: "first", images: [{ name: "a.png", mimeType: "image/png", data: "a" }] };
		const second = { text: "second" };
		const withFirst = enqueueComposerPrompt(emptyComposerQueue("a"), "a", 1, first);
		const withSecond = enqueueComposerPrompt(withFirst, "a", 2, second);

		expect(withSecond.items).toEqual([{ id: 1, request: first }, { id: 2, request: second }]);
		expect(withFirst.items).toHaveLength(1);
	});

	test("a new conversation cannot inherit the previous conversation's queue", () => {
		const previous = enqueueComposerPrompt(emptyComposerQueue("a"), "a", 1, { text: "for a" });
		const next = enqueueComposerPrompt(previous, "b", 2, { text: "for b" });

		expect(next).toEqual({ scope: "b", items: [{ id: 2, request: { text: "for b" } }] });
	});

	test("removing a pending row preserves the order of all other messages", () => {
		let state = enqueueComposerPrompt(emptyComposerQueue("a"), "a", 1, { text: "first" });
		state = enqueueComposerPrompt(state, "a", 2, { text: "second" });
		state = enqueueComposerPrompt(state, "a", 3, { text: "third" });
		expect(removeComposerPrompt(state, "a", 2).items.map(item => item.id)).toEqual([1, 3]);
	});
});
