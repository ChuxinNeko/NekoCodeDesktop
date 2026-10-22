import { Component, lazy, Suspense, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { OpenUIActionsContext } from "../../lib/openuiActions";
import { createOpenUIRuntime, openuiStorageKey } from "../../lib/openuiRuntime";

const OpenUIRenderer = lazy(() => import("./OpenUIRenderer"));
export const MAX_OPENUI_LENGTH = 100_000;

class RenderBoundary extends Component<{ children: ReactNode; fallback: ReactNode; source: string }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	componentDidUpdate(previous: Readonly<{ source: string }>) {
		if (this.state.failed && previous.source !== this.props.source) this.setState({ failed: false });
	}
	render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function OpenUISource({ source, error = false }: { source: string; error?: boolean }) {
	const { t } = useTranslation();
	return <>
		{error ? <p role="status" className="px-3 pt-3 text-xs text-muted-foreground">{t("openui.renderError")}</p> : null}
		<pre className="m-0 max-h-[32rem] overflow-auto"><code>{source}</code></pre>
	</>;
}

/** A fence keeps generated interfaces separate from ordinary Markdown/code. */
export function OpenUIBlock({ source, streaming, documentId, offset = 0 }: { source: string; streaming: boolean; documentId?: string; offset?: number }) {
	const { t } = useTranslation();
	const actions = useContext(OpenUIActionsContext);
	const currentActions = useRef(actions);
	currentActions.current = actions;
	const key = openuiStorageKey(actions.storageScope, documentId, offset);
	const runtime = useMemo(() => createOpenUIRuntime({
		key,
		readProjectJson: path => {
			const read = currentActions.current.readProjectJson;
			if (!read) return Promise.reject(new Error("Project data unavailable"));
			return read(path);
		},
	}), [key]);
	const [showSource, setShowSource] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const oversized = source.length > MAX_OPENUI_LENGTH;
	const content = <figure className="openui-response my-3 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background" data-slot="openui-response">
		<figcaption className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
			<span className="font-medium">{t("openui.title")}</span>
			<Button size="xs" variant="ghost" onClick={() => setExpanded(value => !value)}>{t(expanded ? "openui.collapse" : "openui.expand")}</Button>
			<Button size="xs" variant="ghost" aria-pressed={showSource} onClick={() => setShowSource(value => !value)}>{t(showSource ? "openui.showInterface" : "openui.showSource")}</Button>
		</figcaption>
		{showSource || oversized ? <OpenUISource source={source} error={oversized} /> : null}
		{!oversized ? <div hidden={showSource}>
			<RenderBoundary source={source} fallback={<OpenUISource source={source} error />}>
				<Suspense fallback={<p role="status" className="p-3 text-xs text-muted-foreground">{t("openui.loading")}</p>}>
					<OpenUIRenderer source={source} streaming={streaming} runtime={runtime} />
				</Suspense>
			</RenderBoundary>
		</div> : null}
	</figure>;
	return <Dialog.Root open={expanded} onOpenChange={setExpanded}>
		{expanded ? <Dialog.Portal>
			<Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/50" />
			<Dialog.Popup className="fixed inset-2 z-[71] overflow-auto rounded-xl bg-background p-2 text-foreground shadow-xl outline-none sm:inset-5">
				<Dialog.Title className="sr-only">{t("openui.title")}</Dialog.Title>
				{content}
			</Dialog.Popup>
		</Dialog.Portal> : content}
	</Dialog.Root>;
}
