import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { en, type TranslationKey } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type { TranslationKey } from "./locales/en";

export type Language = "en" | "zh-CN";

/** Simplified Chinese is the product default. */
export const DEFAULT_LANGUAGE: Language = "zh-CN";

const STORAGE_KEY = "nekocode:language";

/** Labels stay in their own language — pickers always read natively. */
export const LANGUAGE_OPTIONS: { id: Language; label: string }[] = [
	{ id: "zh-CN", label: "简体中文" },
	{ id: "en", label: "English" },
];

const MESSAGES: Record<Language, Record<TranslationKey, string>> = {
	en,
	"zh-CN": zhCN,
};

export type TranslateParams = Record<string, string | number>;
export type TranslateFn = (key: TranslationKey, params?: TranslateParams) => string;

function interpolate(template: string, params?: TranslateParams): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

function translate(language: Language, key: TranslationKey, params?: TranslateParams): string {
	// English is the key schema, so it is also the fallback for gaps in another
	// locale — a missing zh-CN entry degrades to English rather than the raw key.
	return interpolate(MESSAGES[language][key] ?? en[key], params);
}

function readStoredLanguage(): Language {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "en" || stored === "zh-CN") return stored;
	} catch {
		// storage unavailable; fall back to the default
	}
	return DEFAULT_LANGUAGE;
}

function writeStoredLanguage(language: Language): void {
	try {
		localStorage.setItem(STORAGE_KEY, language);
	} catch {
		// storage unavailable; the choice just does not persist
	}
}

interface I18nContextValue {
	language: Language;
	setLanguage: (language: Language) => void;
	t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
	const [language, setLanguageState] = useState<Language>(readStoredLanguage);

	const setLanguage = useCallback((next: Language) => {
		setLanguageState(next);
		writeStoredLanguage(next);
	}, []);

	const t = useCallback<TranslateFn>((key, params) => translate(language, key, params), [language]);

	const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
	const context = useContext(I18nContext);
	if (!context) throw new Error("useTranslation must be used inside <I18nProvider>");
	return context;
}
