import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { resetShortcuts, setShortcut, useShortcuts } from "../../hooks/useShortcuts";
import { useTranslation, type TranslationKey } from "../../i18n";
import { formatShortcut, shortcutFromEvent, SHORTCUTS, validShortcut, type ShortcutId, type ShortcutScope } from "../../lib/shortcuts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const GROUPS: Array<{ scope: ShortcutScope; labelKey: TranslationKey }> = [
	{ scope: "app", labelKey: "shortcuts.scope.app" },
	{ scope: "agent", labelKey: "shortcuts.scope.agent" },
	{ scope: "ide", labelKey: "shortcuts.scope.ide" },
	{ scope: "composer", labelKey: "shortcuts.scope.composer" },
];

export function ShortcutSettings() {
	const { t } = useTranslation();
	const { bindings } = useShortcuts();
	const [query, setQuery] = useState("");
	const [recording, setRecording] = useState<ShortcutId | null>(null);
	const [error, setError] = useState<string | null>(null);
	const recordRef = useRef<HTMLInputElement>(null);
	useEffect(() => { if (recording) recordRef.current?.focus(); }, [recording]);
	const assign = (id: ShortcutId, binding: string | null) => {
		const conflict = setShortcut(id, binding);
		if (conflict) {
			const command = SHORTCUTS.find((entry) => entry.id === conflict)!;
			setError(t("shortcuts.conflict", { command: t(command.labelKey) }));
			return;
		}
		setRecording(null);
		setError(null);
	};
	const entries = SHORTCUTS.filter((entry) => (!("desktopOnly" in entry) || api.runtime !== "web") &&
		`${t(entry.labelKey)} ${formatShortcut(bindings[entry.id])}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	return <div className="flex flex-col gap-4">
		<p className="text-sm text-muted-foreground">{t("shortcuts.intro")}</p>
		<div className="flex items-center gap-2">
			<Input aria-label={t("shortcuts.search")} placeholder={t("shortcuts.search")} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1" />
			<Button size="sm" variant="outline" onClick={() => { resetShortcuts(); setRecording(null); setError(null); }}>{t("shortcuts.resetAll")}</Button>
		</div>
		{!entries.length ? <p role="status" className="text-sm text-muted-foreground">{t("shortcuts.empty")}</p> : null}
		{GROUPS.map((group) => {
			const commands = entries.filter((entry) => entry.scope === group.scope);
			if (!commands.length) return null;
			return <section key={group.scope} className="flex flex-col gap-1">
				<h3 className="mb-1 text-sm font-medium">{t(group.labelKey)}</h3>
				{commands.map((entry) => {
					const active = recording === entry.id;
					const binding = bindings[entry.id];
					return <div key={entry.id} data-settings-row data-settings-label={t(entry.labelKey)} className="flex flex-wrap items-center gap-2 border-b border-border/50 py-2">
						<span className="min-w-40 flex-1 text-sm">{t(entry.labelKey)}</span>
						{active ? <input ref={recordRef} data-shortcut-recorder readOnly value={t("shortcuts.recording")}
							aria-label={t("shortcuts.recordLabel", { command: t(entry.labelKey) })}
							className="w-40 rounded-md border border-[color:var(--color-border-focus)] bg-transparent px-2 py-1.5 text-center text-xs outline-none"
							onBlur={() => { setRecording(null); setError(null); }}
							onKeyDown={(event) => {
								event.preventDefault(); event.stopPropagation();
								if (event.nativeEvent.isComposing || event.repeat) return;
								if (event.key === "Escape") { setRecording(null); setError(null); return; }
								if (["Backspace", "Delete"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { assign(entry.id, null); return; }
								const next = shortcutFromEvent(event.nativeEvent);
								if (!next) return;
								if (!validShortcut(next, entry.scope)) { setError(t(entry.scope === "composer" ? "shortcuts.invalidComposer" : "shortcuts.invalid")); return; }
								assign(entry.id, next);
							}}
						/> : <Button size="sm" variant="outline" className="min-w-40 font-mono text-xs" aria-label={t("shortcuts.recordLabel", { command: t(entry.labelKey) })}
							onClick={() => { setRecording(entry.id); setError(null); }}>{formatShortcut(binding) || t("shortcuts.unassigned")}</Button>}
						<Button size="sm" variant="ghost" disabled={binding === null} onClick={() => assign(entry.id, null)}>{t("shortcuts.disable")}</Button>
						<Button size="sm" variant="ghost" disabled={binding === entry.defaultBinding} onClick={() => assign(entry.id, entry.defaultBinding)}>{t("common.reset")}</Button>
						{active && error ? <p role="alert" className="w-full text-xs text-destructive">{error}</p> : null}
					</div>;
				})}
			</section>;
		})}
		{!recording && error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
		<p className="text-xs text-muted-foreground">{t("shortcuts.recordHint")}</p>
	</div>;
}
