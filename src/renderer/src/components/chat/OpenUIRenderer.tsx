import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createParser, Renderer, useRendererQuery, type ActionEvent, type OpenUIError, type ParseResult } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import { openuiLibrary } from "../../lib/openuiLibrary";
import { openuiTheme } from "../../lib/openuiTheme";
import { OpenUIActionsContext, dispatchOpenUIAction, openuiWebUrl } from "../../lib/openuiActions";
import { useOpenLink } from "../../lib/webSources";
import { useTheme } from "../../hooks/useTheme";
import { useTranslation } from "../../i18n";
import { OpenUISource } from "./OpenUIBlock";
import type { OpenUIRuntime } from "../../lib/openuiRuntime";
import { openuiProgramAllowsWrite } from "../../lib/openuiProgram";
import { openuiTools } from "../../lib/openuiToolDefinitions";
import "@openuidev/react-ui/styles/index.css";

const parser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);

function ApplicationDataStatus({ ready }: { ready: boolean }) {
	const { t } = useTranslation();
	const { errors, isLoading, retry } = useRendererQuery();
	const retryWhenReady = useRef(!ready);
	// A project query may have been blocked while its generating agent was busy.
	// Retry failed reads once when that session becomes available; mutations are
	// never re-run here. Later data-source failures keep the explicit Retry button.
	useEffect(() => {
		if (!ready) { retryWhenReady.current = true; return; }
		if (!isLoading && retryWhenReady.current) {
			retryWhenReady.current = false;
			if (errors.length) retry();
		}
	}, [ready, isLoading, errors.length, retry]);
	if (errors.length) return <div role="status" className="mt-2 flex items-center gap-2 text-xs text-destructive"><span>{t("openui.dataError")}</span><button type="button" className="underline" disabled={isLoading || !ready} onClick={retry}>{t("openui.retry")}</button></div>;
	return isLoading ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("openui.dataLoading")}</p> : null;
}

export default function OpenUIRenderer({ source, streaming, runtime }: { source: string; streaming: boolean; runtime: OpenUIRuntime }) {
	const { t } = useTranslation();
	const { resolvedTheme } = useTheme();
	const actions = useContext(OpenUIActionsContext);
	const openLink = useOpenLink();
	const sending = useRef(false);
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState(false);
	const [actionComplete, setActionComplete] = useState(false);
	const [errors, setErrors] = useState<OpenUIError[]>([]);
	const [hasRoot, setHasRoot] = useState<boolean | null>(null);
	const [storageError, setStorageError] = useState(runtime.storageError);
	const [initialState] = useState(() => runtime.getState());
	const toolProvider = useMemo(() => Object.fromEntries(openuiTools.map(({ name }) => [name, (args: Record<string, unknown>) => runtime.callTool(name, args)])), [runtime]);
	useLayoutEffect(() => {
		runtime.setWriteGuard(name => !streaming && openuiProgramAllowsWrite(parser.parse(source), name));
		return () => runtime.setWriteGuard(undefined);
	}, [runtime, source, streaming]);
	const onError = useCallback((errors: OpenUIError[]) => {
		setErrors(previous => JSON.stringify(previous) === JSON.stringify(errors) ? previous : errors);
	}, []);
	const onParseResult = useCallback((result: ParseResult | null) => setHasRoot(result ? !!(result.root || result.rootExpression) : null), []);
	const onStateUpdate = useCallback((state: Record<string, unknown>) => {
		runtime.setState(state);
		setStorageError(runtime.storageError);
	}, [runtime]);
	const onAction = async (event: ActionEvent) => {
		if (streaming || sending.current) return;
		if (actions.disabled) { setActionError(true); return; }
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
	const noContent = hasRoot === false && !streaming;
	const generationErrors = errors.filter(error => error.severity !== "warning" && error.source !== "query" && error.source !== "mutation");
	return <ThemeProvider mode={resolvedTheme} lightTheme={openuiTheme} cssSelector=".openui-response">
		<div className="openui-content p-3" onClickCapture={onLink} onAuxClickCapture={onLink}>
			{noContent ? <OpenUISource source={source} error /> : null}
			{/* Keep the renderer mounted when displaying errors, so a corrected
			    response can recover and switching source view preserves inputs. */}
			<div hidden={noContent}>
				<fieldset disabled={streaming} className="m-0 min-w-0 border-0 p-0" aria-label={t("openui.title")}>
					<Renderer response={source} library={openuiLibrary} initialState={initialState} onStateUpdate={onStateUpdate} toolProvider={toolProvider} isStreaming={streaming} onAction={onAction} onError={onError} onParseResult={onParseResult} publishObservability={false}>
						{/* The SDK hides Content on a query error by default. Keep the
						    generated layout and fallback data available alongside retry. */}
						<Renderer.Content className="openui-generated-content" />
						<ApplicationDataStatus ready={!streaming && !actions.disabled} />
					</Renderer>
				</fieldset>
			</div>
			{!streaming && !noContent && generationErrors.length ? <details className="mt-2 text-xs text-muted-foreground"><summary>{t("openui.partialError")}</summary><ul>{generationErrors.map((error, index) => <li key={index}>{error.message}</li>)}</ul></details> : null}
			{storageError ? <p role="status" className="mt-2 text-xs text-destructive">{t("openui.storageError")}</p> : null}
			{streaming ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("openui.streaming")}</p> : null}
			{pending ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("openui.sending")}</p> : null}
			{actionComplete && !pending ? <p role="status" className="mt-2 text-xs text-muted-foreground">{t("openui.actionComplete")}</p> : null}
			{actionError ? <p role="alert" className="mt-2 text-xs text-destructive">{t("openui.actionError")}</p> : null}
		</div>
	</ThemeProvider>;
}
