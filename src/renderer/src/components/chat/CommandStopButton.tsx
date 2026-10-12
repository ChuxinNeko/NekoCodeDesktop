import { createContext, useContext, useState } from "react";
import { errorMessage } from "../../api";
import { useTranslation } from "../../i18n";

export type StopCommand = (toolCallId: string) => Promise<boolean>;
export const CommandStopContext = createContext<StopCommand | undefined>(undefined);

/** Kept outside the expandable header button: stopping must not toggle the card. */
export function CommandStopButton({ toolCallId, running }: { toolCallId: string; running: boolean }) {
	const stop = useContext(CommandStopContext);
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [stopped, setStopped] = useState(false);
	const [error, setError] = useState("");
	if (!stop || !running) return null;
	return (
		<span className="inline-flex shrink-0 items-center gap-1 pr-2">
			{error ? <span role="alert" className="max-w-40 truncate text-destructive" title={error}>{error}</span> : null}
			<button
				type="button"
				disabled={busy || stopped}
				aria-label={t("toolCall.stopCommand")}
				title={stopped ? t("toolCall.commandStopped") : t("toolCall.stopCommand")}
				className="rounded px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive hover:bg-destructive/10 disabled:cursor-default disabled:opacity-60"
				onClick={async () => {
					setBusy(true);
					setError("");
					try {
						if (await stop(toolCallId)) setStopped(true);
						else setError(t("toolCall.commandNotRunning"));
					} catch (cause) {
						setError(errorMessage(cause));
					} finally {
						setBusy(false);
					}
				}}
			>
				{t(stopped ? "toolCall.commandStopped" : busy ? "toolCall.stoppingCommand" : "toolCall.stopCommand")}
			</button>
		</span>
	);
}
