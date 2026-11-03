import type { ToolCellData } from "../../../../shared/transcript";
import type { WorkflowTodo } from "../../../../shared/workflow";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";

/** Read this call's snapshot, never the session's latest list. */
export function todoItems(cell: ToolCellData): WorkflowTodo[] | null {
	if (cell.toolName !== "todo_write" || cell.status === "error") return null;
	const args = cell.args as { todos?: unknown } | null;
	if (!Array.isArray(args?.todos)) return null;
	const items: WorkflowTodo[] = [];
	for (const entry of args.todos) {
		if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string" ||
			!["pending", "in_progress", "completed", "cancelled"].includes(entry.status)) return null;
		items.push({ id: entry.id, text: entry.text, status: entry.status });
	}
	return items;
}

// Same 24px Remix Icon paths used by baocode, rendered at 14px.
const marks = {
	completed: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12s4.477 10 10 10m5.457-12.543L11 15.914l-4.207-4.207l1.414-1.414L11 13.086l5.043-5.043z",
	in_progress: "M2 12c0 5.523 4.477 10 10 10s10-4.477 10-10S17.523 2 12 2S2 6.477 2 12m18 0a8 8 0 1 1-16 0a8 8 0 0 1 16 0m-2 0a6 6 0 0 1-6 6V6a6 6 0 0 1 6 6",
	pending: "M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16",
};

export function TodoList({ todos }: { todos: WorkflowTodo[] }) {
	const { t } = useTranslation();
	return <ol aria-label={t("workflow.stepsSection")} data-slot="transcript-todos"
		className="my-0.5 mb-1.5 max-h-60 list-none overflow-y-auto rounded-lg border border-border bg-muted/30 px-3 py-2.5">
		{todos.map(todo => <li key={todo.id} className="flex items-start gap-2">
			<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className={cn("mt-1 size-3.5 shrink-0",
				todo.status === "completed" ? "text-emerald-500" : todo.status === "in_progress" ? "text-blue-500" : "text-muted-foreground")}>
				<path d={marks[todo.status === "cancelled" ? "pending" : todo.status]} />
			</svg>
			<span className="sr-only">{t(todo.status === "in_progress" ? "workflow.running" : `workflow.${todo.status}`)}</span>
			<span className={cn("min-w-0 whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] [overflow-wrap:anywhere]",
				todo.status === "completed" || todo.status === "cancelled" ? "text-muted-foreground/65 line-through" : "text-foreground")}>{todo.text}</span>
		</li>)}
	</ol>;
}
