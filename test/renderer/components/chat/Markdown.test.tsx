import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../../../../src/renderer/src/i18n";
import { Markdown } from "../../../../src/renderer/src/components/chat/Markdown";
import { diagramDisplayWidth, MAX_DIAGRAM_LENGTH, renderMermaid } from "../../../../src/renderer/src/lib/mermaid";

const diagram = "解释正文。\n\n```mermaid\nflowchart TD\nA[\"入口\"] --> B[\"处理\"]\n```";
const render = (text: string, props: { user?: boolean; streaming?: boolean } = {}) => renderToString(
	<I18nProvider><Markdown text={text} {...props} /></I18nProvider>);

test("Mermaid fences become diagrams following the prose without invalid pre nesting", () => {
	const html = render(diagram);
	expect(html).toContain("解释正文");
	expect(html).toContain('data-slot="mermaid-diagram"');
	expect(html).not.toContain('<pre><figure');
	expect(html).not.toContain('class="language-mermaid"');
});

test("streaming diagrams wait for a complete answer", () => {
	const html = render(diagram, { streaming: true });
	expect(html).toContain("回答完成后将显示流程图");
	expect(html).not.toContain("data:image/svg+xml");
});

test("ordinary code blocks, inline code and quoted user Mermaid stay as code", () => {
	expect(render("```ts\nconst value = 1;\n```")).toContain('class="language-ts"');
	expect(render("`mermaid` 字样")).not.toContain('data-slot="mermaid-diagram"');
	expect(render(diagram, { user: true })).toContain('class="language-mermaid"');
	expect(render(diagram, { user: true })).not.toContain('data-slot="mermaid-diagram"');
});

test("oversized diagrams fail before loading the rendering library", async () => {
	await expect(renderMermaid("x".repeat(MAX_DIAGRAM_LENGTH + 1), false)).rejects.toThrow("Diagram is too large");
	expect(await renderMermaid("flowchart TD\nA --> B", false, () => false)).toBeNull();
});

test("diagrams fit both axes without enlarging short graphs", () => {
	expect(diagramDisplayWidth('<svg viewBox="0 0 300 1000">', 800)).toBeCloseTo(134.4);
	expect(diagramDisplayWidth('<svg viewBox="0 0 1200 300">', 400)).toBe(368);
	expect(diagramDisplayWidth('<svg viewBox="0 0 200 100">', 800)).toBe(200);
});

test("assistant OpenUI fences become separate interface blocks while user examples remain code", () => {
	const text = 'Before\n\n```openui\nroot = Card([heading])\nheading = CardHeader("Choose")\n```\n\nAfter';
	const html = render(text);
	expect(html).toContain('data-slot="openui-response"');
	expect(html).toContain("Before");
	expect(html).toContain("After");
	expect(html).not.toContain("<pre><figure");
	expect(render(text, { user: true })).toContain('class="language-openui"');
	expect(render(text, { user: true })).not.toContain('data-slot="openui-response"');
	expect(render('`openui` and ordinary code')).not.toContain('data-slot="openui-response"');
});

test("unfinished OpenUI fences are recognized during streaming", () => {
	const html = render('```openui\nroot = Card([heading])\nheading = CardHeader("Cho', { streaming: true });
	expect(html).toContain('data-slot="openui-response"');
});
