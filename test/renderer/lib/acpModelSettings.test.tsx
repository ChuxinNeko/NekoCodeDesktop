import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AcpModelSettings, AcpPresetPicker, AcpProviderForm } from "../../../src/renderer/src/components/settings/AcpModelSettings";
import { I18nProvider } from "../../../src/renderer/src/i18n";
import type { AcpAgentInfo } from "../../../src/shared/acp";
import { ACP_PROVIDER_PRESETS, profileFromPreset } from "../../../src/shared/acp-providers";

const agent: AcpAgentInfo = { id: "codex", name: "Codex", description: "", builtin: true, command: "", commandLine: "", args: [], env: {}, enabled: true };
const render = (children: React.ReactNode) => renderToStaticMarkup(<I18nProvider>{children}</I18nProvider>);

test("ACP settings open on a provider list, without the old routing mode buttons", () => {
	const html = render(<AcpModelSettings agent={agent} />);
	expect(html).toContain("添加供应商");
	expect(html).toContain("已启用");
	expect(html).toContain("当前配置");
	expect(html).not.toContain("使用本机配置");
	expect(html).not.toContain("使用官方地址");
	expect(html).not.toContain('type="password"');
});

test("the preset picker contains CC Switch categories, official login, family grouping and custom setup", () => {
	const html = render(<AcpPresetPicker agentId="codex" onPick={() => {}} />);
	for (const label of ["账号登录", "厂商直连", "第三方服务", "云平台", "本地服务", "自定义配置", "Kimi", "OpenAI Official"]) expect(html).toContain(label);
	expect(html).toContain("需要协议转换");
});

test("official account providers do not show API credentials; custom providers show native config editors", () => {
	const official = ACP_PROVIDER_PRESETS.codex.find((entry) => entry.category === "official")!;
	const props = { agentId: "codex", editing: false, busy: false, onChangePreset: () => {}, onSave: async () => {}, onCancel: () => {} };
	const html = render(<AcpProviderForm {...props} initial={profileFromPreset("codex", official)} preset={official} />);
	expect(html).toContain("codex login");
	expect(html).not.toContain('type="password"');
	const codex = render(<AcpProviderForm {...props} initial={profileFromPreset("codex")} />);
	expect(codex).toContain('type="password"');
	expect(codex).toContain("config.toml");
	expect(codex).toContain("获取模型");
	const claude = render(<AcpProviderForm {...props} agentId="claude" initial={profileFromPreset("claude")} />);
	for (const label of ["settings.json", "Haiku", "Sonnet", "Opus", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) expect(claude).toContain(label);
});
