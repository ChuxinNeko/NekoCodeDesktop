import { useCallback, useContext, useRef, useState, type MouseEvent } from "react";
import { Renderer, type ActionEvent, type OpenUIError } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import { openuiLibrary } from "../../lib/openuiLibrary";
import { openuiTheme } from "../../lib/openuiTheme";
import { OpenUIActionsContext, dispatchOpenUIAction, openuiWebUrl } from "../../lib/openuiActions";
import { useOpenLink } from "../../lib/webSources";
import { useTheme } from "../../hooks/useTheme";
import { useTranslation } from "../../i18n";
import { OpenUISource } from "./OpenUIBlock";
import "@openuidev/react-ui/styles/index.css";

export default function OpenUIRenderer({ source, streaming }: { source: string; streaming: boolean }) {
	const { t } = useTranslation();
	const { resolvedTheme } = useTheme();
	const actions = useContext(OpenUIActionsContext);
	const { send, disabled: sessionBusy } = actions;
	const openLink = useOpenLink();
	const sending = useRef(false);
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState(false);
	const [actionComplete, setActionComplete] = useState(false);
	const [parseError, setParseError] = useState(false);
	const disabled = streaming || sessionBusy || !send || pending;
	const onError = useCallback((errors: OpenUIError[]) => {
		setParseError(errors.some(error => error.severity !== "warning"));
	}, []);
	const onAction = async (event: ActionEvent) => {
		if (disabled || sending.current) return;
		setActionError(false);
		setActionComplete(false);
		sending.current = true;
		setPending(true);
		try {
			if (event.type === "open_url") {
				const url = openuiWebUrl(event.params?.url);
				if (!url) throw new Error("Unsupported URL");
				openLink(url);
				setActionComplete(true);
				return;
			}
			await dispatchOpenUIAction(event, actions, t);
			setActionComplete(true);
		} catch {
			setActionError(true);
		} finally {
			sending.current = false;
			setPending(false);
		}
	};
	// The built-in text and source components can contain anchors. Handle those
	// through the same host opener as action buttons, including middle clicks.
	const onLink = (event: MouseEvent) => {
		const anchor = event.target instanceof Element ? event.target.closest("a") : null;
		if (!anchor) return;
		event.preventDefault();
		event.stopPropagation();
		const url = openuiWebUrl(anchor.getAttribute("href"));
		if (url) openLink(url);
	};
	return <ThemeProvider mode={resolvedTheme} lightTheme={openuiTheme} cssSelector=".openui-response">
		<div className="openui-content p-3" onClickCapture={onLink} onAuxClickCapture={onLink}>
			{parseError && !streaming ? <OpenUISource source={source} error /> : null}
			{/* Keep the renderer mounted when displaying errors, so a corrected
			    response can recover and switching source view preserves inputs. */}
			<div hidden={parseError && !streaming}>
				<fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0" aria-label={t("openui.title")}>
					<Renderer response={source} library={openuiLibrary} isStreaming={streaming} onAction={onAction} onError={onError} publishObservability={false} />
				</fieldset>
			</div>
			{streaming ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("openui.streaming")}</p> : null}
			{pending ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("openui.sending")}</p> : null}
			{actionComplete && !pending ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("openui.actionComplete")}</p> : null}
			{actionError ? <p role="alert" className="mt-2 text-xs text-destructive">{t("openui.actionError")}</p> : null}
		</div>
	</ThemeProvider>;
}
