import { useState } from "react";
import { useTranslation, type TranslationKey } from "../../i18n";
import { BotIcon, DeviceMobileIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MobileSettings } from "./MobileSettings";
import { QqBotSettings } from "./QqBotSettings";

const TABS = [
	{ id: "app", labelKey: "connect.app", Icon: DeviceMobileIcon },
	{ id: "qqbot", labelKey: "connect.qqbot", Icon: BotIcon },
] as const satisfies ReadonlyArray<{ id: string; labelKey: TranslationKey; Icon: typeof BotIcon }>;

type TabId = (typeof TABS)[number]["id"];

/**
 * Everything that drives this desktop from somewhere else.
 *
 * One section rather than one per channel: the phone app and a QQ bot are two
 * ways into the same thing — read the sessions, start a task, get the answer —
 * and splitting them down the settings nav would suggest they configure
 * different features.
 */
export function ConnectSettings() {
	const { t } = useTranslation();
	const [tab, setTab] = useState<TabId>("app");

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-1 self-start rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5">
				{TABS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						onClick={() => setTab(entry.id)}
						className={cn(
							"flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] transition-colors",
							tab === entry.id
								? "bg-[var(--composer-surface)] text-[var(--color-text-foreground)] shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<entry.Icon className="size-3.5" />
						{t(entry.labelKey)}
					</button>
				))}
			</div>
			{tab === "app" ? <MobileSettings /> : <QqBotSettings />}
		</div>
	);
}
