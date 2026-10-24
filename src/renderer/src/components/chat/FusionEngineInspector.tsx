import type { FusionState } from "../../../../shared/fusion-engine-state";
import { useTranslation } from "../../i18n";

/** Projects the reference event stream; it does not orchestrate agents. */
export function FusionEngineInspector({ state, embedded = false }: { state: FusionState; embedded?: boolean }) {
	const { t } = useTranslation();
	if (state.status === "idle" && !state.events.length) return null;
	const plan = state.events.find(event => event.type === "plan.completed");
	const workers = state.events.filter(event => event.type === "task.started" && event.role === "sidekick");
	const Container = embedded ? "section" : "details";
	const Heading = embedded ? "h3" : "summary";
	return <Container className={embedded ? "min-w-0 shrink-0 px-2 py-1 text-xs" : "overflow-auto rounded-lg border border-border/60 bg-background/60 p-3 text-xs"}>
		<Heading className={embedded ? "font-medium text-muted-foreground" : "cursor-pointer font-medium"}>Fusion · {t(`fusion.engine.${state.status}`)}</Heading>
		<div className="mt-2 flex flex-wrap gap-3 break-words text-muted-foreground">
			<span className="min-w-0 break-all">Main · {state.lanes.main} · {state.models?.main}</span>
			<span className="min-w-0 break-all">Sidekick · {state.lanes.sidekick} · {state.models?.sidekick}</span>
		</div>
		{plan?.type === "plan.completed" ? <details className="mt-3">
			<summary className="cursor-pointer">{t("fusion.engine.plan")} · {plan.plan.complexity}</summary>
			<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(plan.plan, null, 2)}</pre>
		</details> : null}
		{workers.map(worker => {
			if (worker.type !== "task.started") return null;
			const events = state.events.filter(event => "workerId" in event && event.workerId === worker.workerId);
			const done = events.find(event => event.type === "task.completed" || event.type === "task.failed");
			const text = events.flatMap(event => event.type === "task.output.delta" ? [event.delta] : []).join("");
			const reasoning = events.flatMap(event => event.type === "task.reasoning.delta" ? [event.delta] : []).join("");
			return <details key={worker.workerId} className={embedded ? "mt-2 border-t border-border/50 py-2" : "mt-3 rounded-md border border-border/50 p-2"}>
				<summary className="cursor-pointer break-words">{worker.task} · {done?.type === "task.failed" ? t("fusion.engine.failed") :
					done ? t("fusion.engine.complete") : t("fusion.engine.running")}</summary>
				<p className="mt-2 break-all text-muted-foreground">{worker.workerId} · {worker.model}</p>
				{reasoning ? <details className="mt-2"><summary className="cursor-pointer">{t("fusion.engine.reasoning")}</summary>
					<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{reasoning}</pre></details> : null}
				{text || done ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{
					done?.type === "task.failed" ? done.message : done?.type === "task.completed" ? done.text : text}</pre> : null}
				{events.filter(event => event.type === "tool.started").map(event => {
					if (event.type !== "tool.started") return null;
					const end = events.find(candidate => (candidate.type === "tool.completed" || candidate.type === "tool.failed") && candidate.toolCallId === event.toolCallId);
					return <details key={event.toolCallId} className="mt-2"><summary className="cursor-pointer">{event.toolName} · {end?.type ?? "running"}</summary>
						<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ input: event.input,
							...(end?.type === "tool.completed" ? { output: end.output, durationMs: end.durationMs } : {}),
							...(end?.type === "tool.failed" ? { error: end.error, durationMs: end.durationMs } : {}) }, null, 2)}</pre></details>;
				})}
			</details>;
		})}
		{state.error ? <p role="alert" className="mt-3 text-destructive">{state.error}</p> : null}
	</Container>;
}
