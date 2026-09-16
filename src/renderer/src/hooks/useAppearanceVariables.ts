// Applies the appearance CSS variables Synara sets at runtime: density, chat column
// width, and the typography scale. index.css carries matching fallbacks, so these
// only need to run once per preference change.

import { useEffect } from "react";
import { getDensityCssVariables, type UiDensity } from "../lib/appDensity";
import { getChatWidthCssVariables, type ChatWidthMode } from "../lib/chatWidth";
import { getAppTypographyScale } from "../lib/appTypography";

export function useAppearanceVariables(input: {
	density: UiDensity;
	chatWidth: ChatWidthMode;
	chatFontSizePx: number;
	terminalFontSizePx: number;
}): void {
	const { density, chatWidth, chatFontSizePx, terminalFontSizePx } = input;

	useEffect(() => {
		const rootStyle = document.documentElement.style;
		const scale = getAppTypographyScale(chatFontSizePx);
		const variables: Record<string, string> = {
			...getDensityCssVariables(density),
			...getChatWidthCssVariables(chatWidth),
			"--app-font-size-base": `${scale.basePx}px`,
			"--app-font-size-ui": `${scale.uiPx}px`,
			"--app-font-size-ui-lg": `${scale.uiLgPx}px`,
			"--app-font-size-ui-sm": `${scale.uiSmPx}px`,
			"--app-font-size-ui-xs": `${scale.uiXsPx}px`,
			"--app-font-size-ui-2xs": `${scale.ui2XsPx}px`,
			"--app-font-size-ui-meta": `${scale.uiMetaPx}px`,
			"--app-font-size-ui-timestamp": `${scale.uiTimestampPx}px`,
			"--app-font-size-chat": `${scale.chatPx}px`,
			"--app-font-size-chat-code": `${scale.chatCodePx}px`,
			"--app-font-size-chat-meta": `${scale.chatMetaPx}px`,
			"--app-font-size-chat-tiny": `${scale.chatTinyPx}px`,
			"--app-font-size-terminal": `${terminalFontSizePx}px`,
		};

		for (const [name, value] of Object.entries(variables)) {
			rootStyle.setProperty(name, value);
		}

		return () => {
			for (const name of Object.keys(variables)) {
				rootStyle.removeProperty(name);
			}
		};
	}, [density, chatWidth, chatFontSizePx, terminalFontSizePx]);
}
