import { useShortcuts } from "../../hooks/useShortcuts";
import { useEffect, useRef, useState } from "react";
import { VscClose, VscDiff } from "react-icons/vsc";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import { cn } from "../../lib/utils";
import { ContextMenu, type ContextMenuState } from "../ui/context-menu";
import type { IdeTab, IdeWorkspace } from "./ide-store";

function baseName(relPath: string): string {
	return relPath.slice(relPath.lastIndexOf("/") + 1);
}

/**
 * The open files, left to right. A preview tab (single-click open) is in italics
 * and is replaced by the next preview; editing or double-clicking keeps it.
 */
export function EditorTabs({
	ws,
	onRequestClose,
	onCopyPath,
	actions,
}: {
	ws: IdeWorkspace;
	/** Close through the editor, which asks about unsaved changes. */
	onRequestClose: (tabIds: string[]) => void;
	onCopyPath: (relPath: string, absolute: boolean) => void;
	actions?: React.ReactNode;
}) {
	const { t } = useTranslation();
	const { label: shortcutLabel } = useShortcuts();
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const stripRef = useRef<HTMLDivElement | null>(null);

	// Keep the active tab scrolled into view as tabs open and switch.
	useEffect(() => {
		const active = stripRef.current?.querySelector<HTMLElement>("[data-active='true']");
		active?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [ws.activeId, ws.tabs.length]);

	// Two tabs on files of the same name say which folder they are in.
	const nameCounts = new Map<string, number>();
	for (const tab of ws.tabs) nameCounts.set(baseName(tab.relPath), (nameCounts.get(baseName(tab.relPath)) ?? 0) + 1);

	const openMenu = (event: React.MouseEvent, tab: IdeTab) => {
		event.preventDefault();
		const index = ws.tabs.findIndex((entry) => entry.id === tab.id);
		const others = ws.tabs.filter((entry) => entry.id !== tab.id).map((entry) => entry.id);
		const right = ws.tabs.slice(index + 1).map((entry) => entry.id);
		const saved = ws.tabs.filter((entry) => !ws.docs.get(entry.relPath)?.dirty).map((entry) => entry.id);
		setMenu({
			x: event.clientX,
			y: event.clientY,
			items: [
				{ label: t("ide.tabs.close"), shortcut: shortcutLabel("ide.closeTab"), onSelect: () => onRequestClose([tab.id]) },
				{ label: t("ide.tabs.closeOthers"), disabled: others.length === 0, onSelect: () => onRequestClose(others) },
				{ label: t("ide.tabs.closeRight"), disabled: right.length === 0, onSelect: () => onRequestClose(right) },
				{ label: t("ide.tabs.closeSaved"), disabled: saved.length === 0, onSelect: () => onRequestClose(saved) },
				{ label: t("ide.tabs.closeAll"), onSelect: () => onRequestClose(ws.tabs.map((entry) => entry.id)) },
				{ kind: "separator" },
				{ label: t("ide.explorer.copyPath"), onSelect: () => onCopyPath(tab.relPath, true) },
				{ label: t("ide.explorer.copyRelativePath"), onSelect: () => onCopyPath(tab.relPath, false) },
				{ kind: "separator" },
				tab.kind === "file"
					? { label: t("ide.tabs.openChanges"), onSelect: () => ws.open(tab.relPath, { kind: "diff" }) }
					: { label: t("ide.tabs.openFile"), onSelect: () => ws.open(tab.relPath) },
				...(tab.preview ? [{ label: t("ide.tabs.keepOpen"), onSelect: () => ws.pin(tab.id) }] : []),
			],
		});
	};

	return (
		<div className="flex h-9 shrink-0 items-stretch border-b border-[color:var(--app-surface-divider)]">
			<div
				ref={stripRef}
				role="tablist"
				className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
				onWheel={(event) => {
					// A vertical wheel scrolls the strip sideways, as in every editor.
					if (event.deltaY && stripRef.current) stripRef.current.scrollLeft += event.deltaY;
				}}
			>
				{ws.tabs.map((tab, index) => {
					const doc = ws.docs.get(tab.relPath);
					const active = tab.id === ws.activeId;
					const name = baseName(tab.relPath);
					const folder = tab.relPath.includes("/") ? tab.relPath.slice(0, tab.relPath.lastIndexOf("/")) : "";
					const ambiguous = (nameCounts.get(name) ?? 0) > 1;
					return (
						<div
							key={tab.id}
							role="tab"
							aria-selected={active}
							data-active={active}
							draggable
							title={tab.relPath}
							onDragStart={(event) => {
								setDragging(tab.id);
								event.dataTransfer.effectAllowed = "move";
							}}
							onDragEnd={() => setDragging(null)}
							onDragOver={(event) => {
								if (dragging && dragging !== tab.id) event.preventDefault();
							}}
							onDrop={(event) => {
								event.preventDefault();
								if (dragging) ws.moveTab(dragging, index);
								setDragging(null);
							}}
							onMouseDown={(event) => {
								if (event.button === 1) {
									event.preventDefault();
									onRequestClose([tab.id]);
								}
							}}
							onClick={() => ws.activate(tab.id)}
							onDoubleClick={() => ws.pin(tab.id)}
							onContextMenu={(event) => openMenu(event, tab)}
							className={cn(
								"group relative flex max-w-60 shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-[color:var(--app-surface-divider)] pl-3 pr-1.5 text-[length:var(--app-font-size-ui,12px)]",
								active
									? "bg-[var(--color-background-elevated-secondary)] text-foreground"
									: "text-muted-foreground hover:bg-[var(--sidebar-accent)] hover:text-foreground",
								dragging === tab.id && "opacity-50",
							)}
						>
							{active ? <span className="absolute inset-x-0 top-0 h-px bg-[var(--color-text-accent)]" /> : null}
							{tab.kind === "diff" ? (
								<VscDiff className="size-3.5 shrink-0 text-muted-foreground" />
							) : (
								<FileTypeIcon name={name} className="size-3.5 shrink-0" />
							)}
							<span className={cn("truncate", tab.preview && "italic", doc?.deleted && "line-through")}>
								{name}
								{tab.kind === "diff" ? <span className="text-muted-foreground"> ({t("ide.tabs.workingTree")})</span> : null}
							</span>
							{ambiguous && folder ? (
								<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/80">{folder}</span>
							) : null}
							<button
								type="button"
								aria-label={t("ide.tabs.close")}
								onClick={(event) => {
									event.stopPropagation();
									onRequestClose([tab.id]);
								}}
								className={cn(
									"relative flex size-5 shrink-0 items-center justify-center rounded hover:bg-[var(--color-background-button-secondary-hover)]",
									!active && !doc?.dirty && "opacity-0 group-hover:opacity-100",
								)}
							>
								{doc?.dirty ? (
									<>
										<span className="size-2 rounded-full bg-foreground/75 group-hover:hidden" />
										<VscClose className="hidden size-3.5 group-hover:block" />
									</>
								) : (
									<VscClose className="size-3.5" />
								)}
							</button>
						</div>
					);
				})}
			</div>
			{actions ? <div className="flex shrink-0 items-center gap-0.5 px-1.5">{actions}</div> : null}
			<ContextMenu menu={menu} onClose={() => setMenu(null)} />
		</div>
	);
}
