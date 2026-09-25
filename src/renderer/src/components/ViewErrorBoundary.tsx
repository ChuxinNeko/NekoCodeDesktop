import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "../i18n";
import { Button } from "./ui/button";

interface Props {
	children: ReactNode;
	/** A change here — switching views, opening another session — clears the error. */
	resetKey: string;
}

interface State {
	error: Error | null;
	resetKey: string;
}

/**
 * Keeps a render error in one view from blanking the whole window.
 *
 * Without it, React unmounts the entire tree on any throw during render, and
 * the user is left with a white window and no way back but a restart. Here the
 * sidebar and title bar stay up, the error is shown, and moving to another view
 * or session — or pressing retry — renders the view again.
 */
export class ViewErrorBoundary extends Component<Props, State> {
	state: State = { error: null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("View crashed:", error, info.componentStack);
	}

	render(): ReactNode {
		if (!this.state.error) return this.props.children;
		return <ViewError error={this.state.error} onRetry={() => this.setState({ error: null })} />;
	}
}

function ViewError({ error, onRetry }: { error: Error; onRetry: () => void }) {
	const { t } = useTranslation();
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("app.viewCrashed")}</p>
			<pre className="max-h-48 max-w-[40rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-background-elevated-secondary)] px-3 py-2 text-left font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
				{error.message}
			</pre>
			<Button onClick={onRetry} size="sm" variant="chrome-outline">
				{t("app.retryView")}
			</Button>
		</div>
	);
}
