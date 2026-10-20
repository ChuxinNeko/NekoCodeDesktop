import type { Theme } from "@openuidev/react-ui";

const ui = "var(--font-ui-family)";
const code = "var(--font-chat-code-family)";
const body = "var(--app-font-size-chat-body, 13px)";
const label = "var(--app-font-size-ui, 12px)";
const small = "var(--app-font-size-ui-sm, 11px)";
const heading = `calc(${body} + 1px)`;

// OpenUI uses font shorthands, so overriding font-size on its parent alone
// cannot align cards (or portalled selects) with the application's typography.
export const openuiTheme: Theme = {
	fontBody: ui, fontHeading: ui, fontLabel: ui, fontNumbers: ui, fontCode: code,
	textBodyXs: `400 ${small}/1.5 ${ui}`,
	textBodyXsHeavy: `500 ${small}/1.5 ${ui}`,
	textBodySm: `400 ${label}/1.5 ${ui}`,
	textBodySmHeavy: `500 ${label}/1.5 ${ui}`,
	textBodyDefault: `400 ${body}/1.5 ${ui}`,
	textBodyDefaultHeavy: `500 ${body}/1.5 ${ui}`,
	textBodyLg: `400 ${heading}/1.5 ${ui}`,
	textBodyLgHeavy: `500 ${heading}/1.5 ${ui}`,
	textHeadingXs: `600 ${body}/1.4 ${ui}`,
	textHeadingSm: `600 ${heading}/1.4 ${ui}`,
	textHeadingMd: `600 calc(${body} + 3px)/1.4 ${ui}`,
	textHeadingLg: `600 calc(${body} + 5px)/1.3 ${ui}`,
	textHeadingXl: `600 calc(${body} + 7px)/1.3 ${ui}`,
	textLabelXs: `400 ${small}/1.4 ${ui}`,
	textLabelXsHeavy: `500 ${small}/1.4 ${ui}`,
	textLabelSm: `400 ${label}/1.4 ${ui}`,
	textLabelSmHeavy: `500 ${label}/1.4 ${ui}`,
	textLabelDefault: `400 ${label}/1.4 ${ui}`,
	textLabelDefaultHeavy: `500 ${label}/1.4 ${ui}`,
	textLabelLg: `500 ${body}/1.4 ${ui}`,
	textNumbersXs: `400 ${small}/1.5 ${ui}`,
	textNumbersXsHeavy: `500 ${small}/1.5 ${ui}`,
	textNumbersSm: `400 ${label}/1.5 ${ui}`,
	textNumbersSmHeavy: `500 ${label}/1.5 ${ui}`,
	textNumbersDefault: `400 ${body}/1.5 ${ui}`,
	textNumbersDefaultHeavy: `500 ${body}/1.5 ${ui}`,
	textNumbersLg: `400 ${heading}/1.5 ${ui}`,
	textNumbersLgHeavy: `500 ${heading}/1.5 ${ui}`,
	textNumbersHeadingSm: `600 ${heading}/1.4 ${ui}`,
	textNumbersHeadingMd: `600 calc(${body} + 3px)/1.4 ${ui}`,
	textNumbersHeadingLg: `600 calc(${body} + 5px)/1.3 ${ui}`,
	textNumbersHeadingXl: `600 calc(${body} + 7px)/1.3 ${ui}`,
	textCodeSm: `400 var(--app-font-size-chat-code, 12px)/1.5 ${code}`,
	textCodeSmHeavy: `600 var(--app-font-size-chat-code, 12px)/1.5 ${code}`,
	textCodeDefault: `400 var(--app-font-size-chat-code, 12px)/1.5 ${code}`,
	textCodeDefaultHeavy: `600 var(--app-font-size-chat-code, 12px)/1.5 ${code}`,
};
