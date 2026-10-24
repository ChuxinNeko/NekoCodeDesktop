import { useShortcuts } from "../../hooks/useShortcuts";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { VscDiff, VscGoToFile, VscSave, VscSparkle, VscSplitHorizontal, VscWarning } from "react-icons/vsc";
import { mentionToken } from "../../../../shared/mentions";
import { errorMessage } from "../../api";
import { readCodeFontFamily, useAppearancePreferences } from "../../hooks/useAppearancePreferences";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import { ChevronRightIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Spinner } from "../ui/spinner";
import { EditorTabs } from "./EditorTabs";
import type { IdeTab, IdeWorkspace } from "./ide-store";
import { extensionRuntime } from "./extension-runtime";
import { languageLabel, monaco } from "./monaco-setup";
import { PanelIconButton } from "./PanelChrome";
import { attachTabCompletion } from "./tab-completion";

export interface EditorStatus {
	relPath: string;
	line: number;
	column: number;
	/** Characters selected across every cursor. */
	selected: number;
	cursors: number;
	language: string;
	languageLabel: string;
	eol: "LF" | "CRLF";
	tabSize: number;
	insertSpaces: boolean;
	bom: boolean;
	errors: number;
	warnings: number;
}

export interface InlineEditRequest {
	relPath: string;
	startLine: number;
	endLine: number;
	selection: string;
	instruction: string;
	language: string;
}

export interface EditorAreaHandle {
	requestClose(tabIds: string[]): void;
	focus(): void;
	/** The selection in the focused editor, for seeding search. */
	selectionText(): string;
	save(): Promise<void>;
	addSelectionToChat(): void;
	openInlineEdit(): void;
	commandPalette(): void;
	gotoLine(): void;
	setEol(eol: "LF" | "CRLF"): void;
	setIndentation(insertSpaces: boolean, tabSize: number): void;
	setLanguage(language: string): void;
	toggleWordWrap(): void;
}

const WORD_WRAP_STORAGE_KEY = "nekocode:ide-word-wrap";

function readWordWrap(): boolean {
	try {
		return localStorage.getItem(WORD_WRAP_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

/** Font options that follow Settings → Appearance; line height scales with the size. */
function editorFontOptions(fontSize: number, ligatures: boolean): monaco.editor.IEditorOptions {
	return { fontFamily: readCodeFontFamily(), fontSize, lineHeight: Math.round(fontSize * 1.54), fontLigatures: ligatures };
}

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
	automaticLayout: true,
	minimap: { enabled: true, renderCharacters: false, maxColumn: 100 },
	scrollBeyondLastLine: false,
	smoothScrolling: true,
	cursorSmoothCaretAnimation: "on",
	cursorBlinking: "smooth",
	renderLineHighlight: "all",
	bracketPairColorization: { enabled: true },
	guides: { bracketPairs: "active", indentation: true },
	stickyScroll: { enabled: true },
	padding: { top: 6, bottom: 6 },
	fixedOverflowWidgets: true,
	mouseWheelZoom: true,
	linkedEditing: true,
	formatOnPaste: false,
	inlineSuggest: { enabled: true, showToolbar: "onHover" },
	tabSize: 2,
	scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
};

function baseName(relPath: string): string {
	return relPath.slice(relPath.lastIndexOf("/") + 1);
}

/** How a selection reads when it is handed to the agent's composer. */
export function selectionForChat(relPath: string, startLine: number, endLine: number, text: string, language: string): string {
	const lines = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
	const fence = text.includes("```") ? "````" : "```";
	return `\`${relPath}\` (L${lines}):\n${fence}${language === "plaintext" ? "" : language}\n${text.replace(/\n+$/, "")}\n${fence}\n`;
}

interface InlineState {
	relPath: string;
	startLine: number;
	endLine: number;
	selection: string;
	language: string;
	top: number;
}

interface CloseQueue {
	current: IdeTab;
	rest: string[];
}

export const EditorArea = forwardRef<
	EditorAreaHandle,
	{
		ws: IdeWorkspace;
		dark: boolean;
		visible: boolean;
		onStatus: (status: EditorStatus | null) => void;
		onAddToChat: (text: string) => void;
		onInlineEdit: (request: InlineEditRequest) => Promise<void>;
		onQuickOpen: () => void;
		onFocusChat: () => void;
		onError: (message: string) => void;
	}
>(function EditorArea({ ws, dark, visible, onStatus, onAddToChat, onInlineEdit, onQuickOpen, onFocusChat, onError }, ref) {
	const { t } = useTranslation();
	useSyncExternalStore(ws.subscribe, ws.getVersion);
	const codeHostRef = useRef<HTMLDivElement | null>(null);
	const diffHostRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
	const shownTabRef = useRef<string | null>(null);
	const handledRevealRef = useRef(0);
	const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
	const [wordWrap, setWordWrap] = useState(readWordWrap);
	const { preferences: appearance } = useAppearancePreferences();
	const appearanceRef = useRef(appearance);
	appearanceRef.current = appearance;
	const [sideBySide, setSideBySide] = useState(true);
	const [closeQueue, setCloseQueue] = useState<CloseQueue | null>(null);
	const [inline, setInline] = useState<InlineState | null>(null);
	const [instruction, setInstruction] = useState("");
	const [inlineBusy, setInlineBusy] = useState(false);
	const [reloadNotice, setReloadNotice] = useState(false);

	// Tab completion serves this workspace's files while it is open.
	useEffect(() => attachTabCompletion(ws.cwd), [ws.cwd]);

	const active = ws.activeTab;
	const doc = active ? ws.docs.get(active.relPath) : undefined;
	const head = active?.kind === "diff" ? ws.headModels.get(active.relPath) : undefined;

	/** The editor the user is looking at: the plain one, or the diff's right side. */
	const currentEditor = useCallback((): monaco.editor.ICodeEditor | null => {
		const tab = ws.activeTab;
		if (!tab) return null;
		return tab.kind === "diff" ? (diffRef.current?.getModifiedEditor() ?? null) : editorRef.current;
	}, [ws]);

	// Callbacks the Monaco actions call, read through a ref so the actions can be
	// registered once and still see this render's props.
	const latest = useRef({ onAddToChat, onQuickOpen, onFocusChat, onError });
	latest.current = { onAddToChat, onQuickOpen, onFocusChat, onError };

	const saveActive = useCallback(async () => {
		const tab = ws.activeTab;
		if (!tab) return;
		try {
			const result = await ws.save(tab.relPath);
			if (result && !result.ok) latest.current.onError(t("ide.editor.saveConflict", { name: baseName(tab.relPath) }));
		} catch (cause) {
			latest.current.onError(errorMessage(cause));
		}
	}, [ws, t]);

	const addSelectionToChat = useCallback(() => {
		const editor = currentEditor();
		const model = editor?.getModel();
		const tab = ws.activeTab;
		if (!editor || !model || !tab) return;
		const selection = editor.getSelection();
		if (!selection || selection.isEmpty()) {
			// Nothing selected: the file itself, as an @ reference.
			latest.current.onAddToChat(`${mentionToken({ kind: "file", path: tab.relPath })} `);
			return;
		}
		latest.current.onAddToChat(
			selectionForChat(
				tab.relPath,
				selection.startLineNumber,
				selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
					? selection.endLineNumber - 1
					: selection.endLineNumber,
				model.getValueInRange(selection),
				model.getLanguageId(),
			),
		);
	}, [currentEditor, ws]);

	const openInlineEdit = useCallback(() => {
		const editor = currentEditor();
		const model = editor?.getModel();
		const tab = ws.activeTab;
		if (!editor || !model || !tab) return;
		const selection = editor.getSelection();
		let startLine = selection?.startLineNumber ?? 1;
		let endLine = selection?.endLineNumber ?? startLine;
		if (selection && !selection.isEmpty() && selection.endColumn === 1 && endLine > startLine) endLine--;
		if (!selection || selection.isEmpty()) {
			startLine = selection?.positionLineNumber ?? 1;
			endLine = startLine;
		}
		const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
		decorationsRef.current?.clear();
		decorationsRef.current = editor.createDecorationsCollection([
			{ range, options: { isWholeLine: true, className: "ide-inline-edit-range" } },
		]);
		const position = editor.getScrolledVisiblePosition({ lineNumber: startLine, column: 1 });
		setInstruction("");
		setInline({
			relPath: tab.relPath,
			startLine,
			endLine,
			selection: model.getValueInRange(range),
			language: model.getLanguageId(),
			top: Math.max(4, (position?.top ?? 0) - 46),
		});
	}, [currentEditor, ws]);

	const closeInline = useCallback(() => {
		decorationsRef.current?.clear();
		setInline(null);
		currentEditor()?.focus();
	}, [currentEditor]);

	const actionsRef = useRef({ saveActive, addSelectionToChat, openInlineEdit });
	actionsRef.current = { saveActive, addSelectionToChat, openInlineEdit };

	// The editors, created once and fed models as tabs switch.
	useEffect(() => {
		const codeHost = codeHostRef.current;
		const diffHost = diffHostRef.current;
		if (!codeHost || !diffHost) return;
		const fontOptions = editorFontOptions(appearanceRef.current.editorFontSizePx, appearanceRef.current.codeLigatures);
		const editor = monaco.editor.create(codeHost, { ...EDITOR_OPTIONS, ...fontOptions, model: null, wordWrap: readWordWrap() ? "on" : "off" });
		const diff = monaco.editor.createDiffEditor(diffHost, {
			...EDITOR_OPTIONS,
			...fontOptions,
			originalEditable: false,
			renderSideBySide: true,
			ignoreTrimWhitespace: false,
			renderOverviewRuler: true,
		});
		editorRef.current = editor;
		diffRef.current = diff;

		const register = (target: monaco.editor.IStandaloneCodeEditor) => [
			target.addAction({
				id: "nekocode.save",
				label: t("ide.command.save"),
				keybindings: [],
				run: () => void actionsRef.current.saveActive(),
			}),
			target.addAction({
				id: "nekocode.saveAll",
				label: t("ide.command.saveAll"),
				keybindings: [],
				run: () => void ws.saveAll(),
			}),
			target.addAction({
				id: "nekocode.addToChat",
				label: t("ide.command.addToChat"),
				keybindings: [],
				contextMenuGroupId: "0_agent",
				contextMenuOrder: 1,
				run: () => actionsRef.current.addSelectionToChat(),
			}),
			target.addAction({
				id: "nekocode.inlineEdit",
				label: t("ide.command.inlineEdit"),
				keybindings: [],
				contextMenuGroupId: "0_agent",
				contextMenuOrder: 2,
				run: () => actionsRef.current.openInlineEdit(),
			}),
			target.addAction({
				id: "nekocode.quickOpen",
				label: t("ide.command.quickOpen"),
				keybindings: [],
				run: () => latest.current.onQuickOpen(),
			}),
			target.addAction({
				id: "nekocode.commandPalette",
				label: t("ide.command.palette"),
				keybindings: [],
				run: (instance) => instance.trigger("nekocode", "editor.action.quickCommand", null),
			}),
			target.addAction({
				id: "nekocode.focusChat",
				label: t("ide.command.toggleChat"),
				keybindings: [],
				run: () => latest.current.onFocusChat(),
			}),
			target.addAction({
				id: "nekocode.wordWrap",
				label: t("ide.command.wordWrap"),
				keybindings: [],
				run: () => setWordWrap((value) => !value),
			}),
		];
		// The diff editor builds its sides as standalone editors, so they take actions too.
		const disposables = [...register(editor), ...register(diff.getModifiedEditor() as monaco.editor.IStandaloneCodeEditor)];
		return () => {
			for (const disposable of disposables) disposable.dispose();
			editor.dispose();
			diff.dispose();
			editorRef.current = null;
			diffRef.current = null;
		};
	}, [ws, t]);

	useEffect(() => {
		try {
			localStorage.setItem(WORD_WRAP_STORAGE_KEY, wordWrap ? "1" : "0");
		} catch {
			// not persisted
		}
		editorRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
		diffRef.current?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
	}, [wordWrap]);

	useEffect(() => {
		diffRef.current?.updateOptions({ renderSideBySide: sideBySide });
	}, [sideBySide]);

	useEffect(() => {
		const fontOptions = editorFontOptions(appearance.editorFontSizePx, appearance.codeLigatures);
		editorRef.current?.updateOptions(fontOptions);
		diffRef.current?.updateOptions(fontOptions);
	}, [appearance.editorFontSizePx, appearance.codeLigatures, appearance.codeFontFamily]);

	// The theme follows the app's, and is drawn from its tokens.
	useEffect(() => {
		extensionRuntime.setDark(dark);
	}, [dark]);

	// Put the active tab's document in the editor that shows it, keeping each
	// tab's scroll position and cursors as the user left them.
	useEffect(() => {
		const editor = editorRef.current;
		const diff = diffRef.current;
		if (!editor || !diff) return;
		const previous = shownTabRef.current;
		if (previous && previous !== active?.id && previous.startsWith("file:") && editor.getModel()) {
			ws.viewStates.set(previous, editor.saveViewState());
		}
		shownTabRef.current = active?.id ?? null;
		const model = doc?.model ?? null;
		if (active?.kind === "file") {
			if (editor.getModel() !== model) {
				editor.setModel(model);
				const state = active ? ws.viewStates.get(active.id) : undefined;
				if (state) editor.restoreViewState(state);
			}
		} else {
			editor.setModel(null);
		}
		if (active?.kind === "diff" && model && head) {
			const current = diff.getModel();
			if (current?.modified !== model || current?.original !== head) diff.setModel({ original: head, modified: model });
		} else if (diff.getModel()) {
			diff.setModel(null);
		}
		if (inline && inline.relPath !== active?.relPath) closeInline();
	}, [active?.id, active?.kind, doc?.model, head, ws]);

	// Jump to a line — a search result, a quick-open `file:42`.
	useEffect(() => {
		const reveal = ws.reveal;
		if (!reveal || reveal.nonce === handledRevealRef.current || reveal.tabId !== active?.id || !doc?.model) return;
		const editor = currentEditor();
		if (!editor || editor.getModel() !== doc.model) return;
		handledRevealRef.current = reveal.nonce;
		const range = new monaco.Range(reveal.line, reveal.column, reveal.endLine ?? reveal.line, reveal.endColumn ?? reveal.column);
		editor.setSelection(range);
		editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
		editor.focus();
	});

	// Focus the editor when a tab is opened or switched to, as editors do.
	useEffect(() => {
		if (visible && doc?.state === "ready") currentEditor()?.focus();
	}, [active?.id, doc?.state, visible, currentEditor]);

	// A brief note when the disk's version replaced a clean buffer — usually the agent's edit.
	useEffect(() => {
		if (!doc?.reloadedAt || Date.now() - doc.reloadedAt > 3000) return;
		setReloadNotice(true);
		const timer = setTimeout(() => setReloadNotice(false), 3000);
		return () => clearTimeout(timer);
	}, [doc?.reloadedAt]);

	// What the status bar shows: cursor, selection, language, line endings, problems.
	useEffect(() => {
		const editor = currentEditor();
		const model = doc?.model;
		if (!editor || !model || !active) {
			onStatus(null);
			return;
		}
		const report = () => {
			const selections = editor.getSelections() ?? [];
			const position = editor.getPosition();
			const markers = monaco.editor.getModelMarkers({ resource: model.uri });
			const options = model.getOptions();
			onStatus({
				relPath: active.relPath,
				line: position?.lineNumber ?? 1,
				column: position?.column ?? 1,
				selected: selections.reduce((sum, selection) => sum + model.getValueLengthInRange(selection), 0),
				cursors: selections.length,
				language: model.getLanguageId(),
				languageLabel: languageLabel(model.getLanguageId()),
				eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
				tabSize: options.tabSize,
				insertSpaces: options.insertSpaces,
				bom: doc?.bom ?? false,
				errors: markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Error).length,
				warnings: markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Warning).length,
			});
		};
		report();
		const disposables = [
			editor.onDidChangeCursorSelection(report),
			model.onDidChangeContent(report),
			model.onDidChangeOptions(report),
			model.onDidChangeLanguage(report),
			monaco.editor.onDidChangeMarkers((uris) => {
				if (uris.some((uri) => uri.toString() === model.uri.toString())) report();
			}),
		];
		return () => {
			for (const disposable of disposables) disposable.dispose();
		};
	}, [active?.id, active?.kind, doc?.model, doc?.bom, head, currentEditor, onStatus]);

	// ---------------------------------------------------------------------------
	// Closing
	// ---------------------------------------------------------------------------

	const processClose = useCallback(
		(ids: string[]) => {
			const queue = [...ids];
			while (queue.length) {
				const id = queue.shift()!;
				if (ws.closeLosesEdits(id)) {
					const tab = ws.tabs.find((entry) => entry.id === id);
					if (tab) {
						ws.activate(id);
						setCloseQueue({ current: tab, rest: queue });
						return;
					}
				}
				ws.close(id);
			}
			setCloseQueue(null);
		},
		[ws],
	);

	const resolveClose = async (choice: "save" | "discard" | "cancel") => {
		const queue = closeQueue;
		if (!queue) return;
		if (choice === "cancel") {
			setCloseQueue(null);
			return;
		}
		if (choice === "save") {
			try {
				const result = await ws.save(queue.current.relPath);
				if (result && !result.ok) {
					setCloseQueue(null);
					onError(t("ide.editor.saveConflict", { name: baseName(queue.current.relPath) }));
					return;
				}
			} catch (cause) {
				setCloseQueue(null);
				onError(errorMessage(cause));
				return;
			}
		}
		ws.close(queue.current.id);
		processClose(queue.rest);
	};

	useImperativeHandle(
		ref,
		() => ({
			requestClose: processClose,
			focus: () => currentEditor()?.focus(),
			selectionText: () => {
				const editor = currentEditor();
				const selection = editor?.getSelection();
				const model = editor?.getModel();
				if (!selection || !model || selection.isEmpty() || selection.startLineNumber !== selection.endLineNumber) return "";
				return model.getValueInRange(selection);
			},
			save: saveActive,
			addSelectionToChat,
			openInlineEdit,
			commandPalette: () => {
				const editor = currentEditor();
				editor?.focus();
				editor?.trigger("nekocode", "editor.action.quickCommand", null);
			},
			gotoLine: () => {
				const editor = currentEditor();
				editor?.focus();
				editor?.trigger("nekocode", "editor.action.gotoLine", null);
			},
			setEol: (eol) => {
				const model = currentEditor()?.getModel();
				model?.pushEOL(eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
			},
			setIndentation: (insertSpaces, tabSize) => currentEditor()?.getModel()?.updateOptions({ insertSpaces, tabSize }),
			setLanguage: (language) => {
				const model = currentEditor()?.getModel();
				if (model) monaco.editor.setModelLanguage(model, language);
			},
			toggleWordWrap: () => setWordWrap((value) => !value),
		}),
		[processClose, currentEditor, saveActive, addSelectionToChat, openInlineEdit],
	);

	const submitInline = async () => {
		const state = inline;
		const text = instruction.trim();
		if (!state || !text) return;
		setInlineBusy(true);
		try {
			// The agent edits the file on disk; it has to see what is on screen.
			const pending = ws.docs.get(state.relPath);
			if (pending?.dirty) {
				const saved = await ws.save(state.relPath);
				if (saved && !saved.ok) throw new Error(t("ide.editor.saveConflict", { name: baseName(state.relPath) }));
			}
			await onInlineEdit({ ...state, instruction: text });
			closeInline();
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setInlineBusy(false);
		}
	};

	const copyPath = (relPath: string, absolute: boolean) => {
		if (!absolute) {
			void navigator.clipboard.writeText(relPath);
			return;
		}
		const separator = ws.cwd.includes("\\") ? "\\" : "/";
		void navigator.clipboard.writeText(`${ws.cwd.replace(/[\\/]+$/, "")}${separator}${relPath.split("/").join(separator)}`);
	};

	const segments = active ? active.relPath.split("/") : [];
	const showCode = active?.kind === "file" && doc?.state === "ready";
	const showDiff = active?.kind === "diff" && doc?.state === "ready" && !!head;

	const toolbar = active ? (
		<>
			{active.kind === "file" ? (
				<PanelIconButton label={t("ide.tabs.openChanges")} onClick={() => ws.open(active.relPath, { kind: "diff" })}>
					<VscDiff />
				</PanelIconButton>
			) : (
				<>
					<PanelIconButton label={t("ide.editor.toggleInlineDiff")} active={!sideBySide} onClick={() => setSideBySide((v) => !v)}>
						<VscSplitHorizontal />
					</PanelIconButton>
					<PanelIconButton label={t("ide.tabs.openFile")} onClick={() => ws.open(active.relPath)}>
						<VscGoToFile />
					</PanelIconButton>
				</>
			)}
			<PanelIconButton label={t("ide.command.inlineEdit")} onClick={openInlineEdit} disabled={doc?.state !== "ready"}>
				<VscSparkle />
			</PanelIconButton>
			<PanelIconButton label={t("ide.command.save")} onClick={() => void saveActive()} disabled={!doc?.dirty}>
				<VscSave />
			</PanelIconButton>
		</>
	) : null;

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			{ws.tabs.length > 0 ? <EditorTabs ws={ws} onRequestClose={processClose} onCopyPath={copyPath} actions={toolbar} /> : null}

			{active ? (
				<div className="flex h-[22px] shrink-0 items-center gap-0.5 overflow-hidden px-3 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{segments.map((segment, index) => (
						<span key={`${index}:${segment}`} className="flex shrink-0 items-center gap-0.5">
							{index > 0 ? <ChevronRightIcon className="size-3 opacity-60" /> : null}
							{index === segments.length - 1 ? (
								<>
									<FileTypeIcon name={segment} className="size-3" />
									<span className="text-foreground/85">{segment}</span>
								</>
							) : (
								<span>{segment}</span>
							)}
						</span>
					))}
					{active.kind === "diff" ? <span className="ml-2 shrink-0">· HEAD ↔ {t("ide.tabs.workingTree")}</span> : null}
				</div>
			) : null}

			{doc?.conflict ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-[color:var(--warning)]/40 bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
					<VscWarning className="shrink-0 text-[var(--warning)]" />
					<span className="min-w-0 flex-1">{t("ide.editor.conflict")}</span>
					<Button size="xs" variant="chrome-outline" onClick={() => void ws.revert(doc.relPath)}>
						{t("ide.editor.useDisk")}
					</Button>
					<Button size="xs" variant="chrome-outline" onClick={() => void ws.save(doc.relPath, true)}>
						{t("ide.editor.overwrite")}
					</Button>
				</div>
			) : doc?.deleted ? (
				<div className="flex shrink-0 items-center gap-2 border-y border-[color:var(--app-surface-divider)] bg-[var(--color-background-elevated-secondary)] px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
					<span className="min-w-0 flex-1">{t("ide.editor.deleted")}</span>
					{doc.model ? (
						<Button size="xs" variant="chrome-outline" onClick={() => void ws.save(doc.relPath, true)}>
							{t("ide.editor.saveAgain")}
						</Button>
					) : null}
				</div>
			) : null}

			<div className="relative min-h-0 flex-1">
				{/* `monaco-component` is where Monaco's theme variables are defined.
				    The right-click menu mounts beside the editor, not inside it, and
				    without them there draws with no background at all. */}
				<div ref={codeHostRef} className={cn("monaco-component absolute inset-0", !showCode && "layout-hidden")} />
				<div ref={diffHostRef} className={cn("monaco-component absolute inset-0", !showDiff && "layout-hidden")} />

				{reloadNotice && (showCode || showDiff) ? (
					<div className="pointer-events-none absolute right-6 top-2 z-10 rounded-full border border-[color:var(--app-surface-divider)] bg-[var(--popover)] px-2.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground shadow-sm">
						{t("ide.editor.reloaded")}
					</div>
				) : null}

				{inline && (showCode || showDiff) ? (
					<div
						className="absolute left-14 right-8 z-20 flex max-w-[640px] flex-col gap-1.5 rounded-xl border border-[color:var(--color-text-accent)]/50 bg-[var(--popover)] p-2 shadow-xl"
						style={{ top: inline.top }}
					>
						<div className="flex items-center gap-2">
							<VscSparkle className="shrink-0 text-[var(--color-text-accent)]" />
							<input
								autoFocus
								value={instruction}
								disabled={inlineBusy}
								onChange={(event) => setInstruction(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										void submitInline();
									} else if (event.key === "Escape") {
										event.preventDefault();
										closeInline();
									}
								}}
								placeholder={t("ide.inline.placeholder")}
								className="min-w-0 flex-1 bg-transparent text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground/70"
							/>
							{inlineBusy ? <Spinner className="size-3.5" /> : null}
						</div>
						<div className="flex items-center gap-2 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
							<span className="flex-1">
								{t("ide.inline.scope", {
									file: baseName(inline.relPath),
									lines: inline.startLine === inline.endLine ? `${inline.startLine}` : `${inline.startLine}-${inline.endLine}`,
								})}
							</span>
							<span>{t("ide.inline.hint")}</span>
						</div>
					</div>
				) : null}

				{!active ? (
					<EmptyEditor onQuickOpen={onQuickOpen} />
				) : !doc || doc.state === "loading" || (active.kind === "diff" && doc.state === "ready" && !head) ? (
					<div className="absolute inset-0 flex items-center justify-center">
						<Spinner className="size-4" />
					</div>
				) : doc.state === "image" ? (
					<div className="absolute inset-0 flex items-center justify-center overflow-auto p-6">
						<img
							src={doc.imageUrl}
							alt={active.relPath}
							className="max-h-full max-w-full rounded border border-[color:var(--app-surface-divider)] [background:repeating-conic-gradient(#8882_0%_25%,transparent_0%_50%)_50%/16px_16px]"
						/>
					</div>
				) : doc.state === "binary" || doc.state === "tooLarge" || doc.state === "error" ? (
					<div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{doc.state === "binary"
							? t("ide.editor.binary")
							: doc.state === "tooLarge"
								? t("ide.editor.tooLarge", { size: `${Math.round((doc.size ?? 0) / 1024 / 1024)} MB` })
								: doc.error}
					</div>
				) : null}
			</div>

			<ConfirmDialog
				open={closeQueue !== null}
				onOpenChange={(open) => {
					if (!open) void resolveClose("cancel");
				}}
				title={t("ide.editor.unsavedTitle", { name: closeQueue ? baseName(closeQueue.current.relPath) : "" })}
				description={t("ide.editor.unsavedDescription")}
				footer={
					<>
						<Button onClick={() => void resolveClose("cancel")} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button onClick={() => void resolveClose("discard")} size="sm" variant="chrome-outline">
							{t("ide.editor.dontSave")}
						</Button>
						<Button autoFocus onClick={() => void resolveClose("save")} size="sm" variant="default">
							{t("common.save")}
						</Button>
					</>
				}
			/>
		</div>
	);
});

function EmptyEditor({ onQuickOpen }: { onQuickOpen: () => void }) {
	const { label } = useShortcuts();
	const { t } = useTranslation();
	const shortcuts: Array<[string, string]> = [
		[t("ide.command.quickOpen"), label("ide.quickOpen")],
		[t("ide.command.palette"), label("ide.palette")],
		[t("ide.search.title"), label("ide.search")],
		[t("ide.command.addToChat"), label("ide.addToChat")],
		[t("ide.command.inlineEdit"), label("ide.inlineEdit")],
		[t("ide.command.toggleTerminal"), label("ide.terminal")],
		[t("ide.command.toggleChat"), label("ide.focusChat")],
	];
	return (
		<div className="absolute inset-0 flex flex-col items-center justify-center gap-5 p-6">
			<img src="./icon.png" alt="" aria-hidden="true" draggable={false} className="size-16 opacity-25 grayscale" />
			<div className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
				{shortcuts.map(([label, keys]) => (
					<div key={label} className="contents">
						<span className="text-right text-muted-foreground">{label}</span>
						<kbd className="font-sans text-muted-foreground/80">{keys}</kbd>
					</div>
				))}
			</div>
			<Button size="sm" variant="chrome-outline" onClick={onQuickOpen}>
				{t("ide.command.quickOpen")}
			</Button>
		</div>
	);
}
