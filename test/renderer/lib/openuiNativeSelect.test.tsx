import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Renderer } from "@openuidev/react-lang";
import { openuiLibrary } from "../../../src/renderer/src/lib/openuiLibrary";

const response = `root = Card([form])
form = Form("requirements", buttons, [field])
buttons = Buttons([submit])
submit = Button("提交", @SubmitToAgent("继续"))
field = FormControl("优先级", priority)
priority = Select("priority", [low, high], "请选择", null, "high")
low = SelectItem("low", "低")
high = SelectItem("high", "高")`;

test("a generated Select renders a labelled native field with the original option values and initial selection", () => {
	const html = renderToStaticMarkup(<Renderer response={response} library={openuiLibrary} publishObservability={false} />);
	expect(html).toContain('<select id="priority" name="priority"');
	expect(html).toContain('for="priority"');
	expect(html).toContain('<option value="low">低</option>');
	expect(html).toContain('<option value="high" selected="">高</option>');
	expect(html).not.toContain("data-radix");
});

test("the priority field remains disabled while a reply is streaming", () => {
	const html = renderToStaticMarkup(<Renderer response={response} library={openuiLibrary} isStreaming publishObservability={false} />);
	expect(html).toMatch(/<select[^>]+disabled=""/);
});
