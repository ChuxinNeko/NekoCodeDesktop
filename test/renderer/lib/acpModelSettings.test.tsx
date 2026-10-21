import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpModelSettings } from "../../../src/renderer/src/components/settings/AcpModelSettings";
import { I18nProvider } from "../../../src/renderer/src/i18n";
import type { AcpAgentInfo } from "../../../src/shared/acp";

const agent: AcpAgentInfo = { id: "codex", name: "Codex", description: "", builtin: true, command: "", commandLine: "", args: [], env: {}, enabled: true };
const render = (value: AcpAgentInfo) => renderToStaticMarkup(<I18nProvider><AcpModelSettings agent={value} /></I18nProvider>);

test("ACP defaults offer local configuration, official endpoint and custom API", () => {
	const html = render(agent);
	expect(html).toContain("使用本机配置");
	expect(html).toContain("使用官方地址");
	expect(html).toContain("自定义 API");
	expect(html).not.toContain('type="password"');
});

test("custom Codex and Claude forms expose their supported protocol and model controls", () => {
	const modelSettings = { mode: "custom" as const, baseUrl: "https://example.test/v1", apiKey: "key", model: "custom-model" };
	const codex = render({ ...agent, modelSettings });
	expect(codex).toContain("OpenAI Responses");
	expect(codex).toContain('type="password"');
	expect(codex).toContain("推理强度");
	const claude = render({ ...agent, id: "claude", modelSettings });
	expect(claude).toContain("Anthropic Messages");
	expect(claude).toContain("Haiku");
	expect(claude).toContain("Sonnet");
	expect(claude).toContain("Opus");
	expect(claude).not.toContain("推理强度");
});

test("other ACP agents use the environment editor instead of unsupported API controls", () => {
	const html = render({ ...agent, id: "cursor", env: { KEEP: "value" } });
	expect(html).toContain("KEY=value");
	expect(html).toContain("KEEP=value");
	expect(html).not.toContain("自定义 API");
});
