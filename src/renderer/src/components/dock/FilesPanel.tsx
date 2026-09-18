import { useEffect, useState } from "react";
import type { FsEntry, FsReadResult } from "../../../../shared/files";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import {
	SIDEBAR_HEADER_ROW_CLASS_NAME,
	SIDEBAR_ROW_HOVER_CLASS_NAME,
	SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../../lib/sidebarRowStyles";
import { FileTypeIcon } from "../../lib/fileIcons";
import { highlightFileToHtml } from "../../lib/codeHighlight";
import {
	ArrowLeftIcon,
	FolderIcon,
} from "../../lib/icons";
import { IconButton } from "../ui/icon-button";
import { Spinner } from "../ui/spinner";

/**
 * The dock's Files pane: a directory list under the project root, a level of
 * preview for text files. Directory navigation keeps a stack of relative
 * paths (round-tripped through main, which guards against escaping the root),
 * so "up" is a pop rather than string manipulation on separators.
 */
export function FilesPanel({ cwd }: { cwd: string | null }) {
	const { t } = useTranslation();
	const [stack, setStack] = useState<string[]>([]);
	const [entries, setEntries] = useState<FsEntry[] | null>(null);
	const [preview, setPreview] = useState<{ path: string } & FsReadResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const dir = stack[stack.length - 1] ?? "";

	// A project switch invalidates both the path stack and any open preview.
	useEffect(() => {
		setStack([]);
		setPreview(null);
		setError(null);
	}, [cwd]);

	useEffect(() => {
		if (!cwd) return;
		let cancelled = false;
		setLoading(true);
		api
			.fsList(cwd, dir)
			.then((next) => {
				if (cancelled) return;
				setEntries(next);
				setError(null);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(errorMessage(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, dir]);

	const openFile = async (entry: FsEntry) => {
		if (!cwd) return;
		try {
			const result = await api.fsReadFile(cwd, entry.relPath);
			setPreview({ path: entry.relPath, ...result });
			setError(null);
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	if (!cwd) {
		return (
			<p className="p-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{t("files.openProject")}
			</p>
		);
	}

	if (preview) {
		return (
			<FilePreview
				name={preview.path}
				onBack={() => setPreview(null)}
				text={preview.text}
				truncated={preview.truncated}
			/>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-8 shrink-0 items-center gap-1 border-b border-[color:var(--app-surface-divider)] px-1.5">
				{stack.length > 0 ? (
					<IconButton
						label={t("files.up")}
						onClick={() => setStack((current) => current.slice(0, -1))}
						tooltip={t("files.up")}
					>
						<ArrowLeftIcon className="size-3.5" />
					</IconButton>
				) : null}
				<span className="min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{dir || "."}
				</span>
				{loading ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
			</div>
			{error ? (
				<p className="shrink-0 px-3 py-1.5 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
				{entries !== null && entries.length === 0 ? (
					<p className="px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("files.empty")}
					</p>
				) : (
					entries?.map((entry) => (
						<button
							key={entry.relPath}
							type="button"
							onClick={() =>
								entry.kind === "dir"
									? setStack((current) => [...current, entry.relPath])
									: void openFile(entry)
							}
							className={cn(
								SIDEBAR_HEADER_ROW_CLASS_NAME,
								SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
								SIDEBAR_ROW_HOVER_CLASS_NAME,
							)}
						>
							{entry.kind === "dir" ? (
								<FolderIcon className="size-3.5 shrink-0 opacity-80" />
							) : (
								<FileTypeIcon name={entry.name} className="size-3.5 shrink-0" />
							)}
							<span className="min-w-0 flex-1 truncate">{entry.name}</span>
						</button>
					))
				)}
			</div>
		</div>
	);
}

/**
 * Read-only file preview styled like a VS Code editor surface: Shiki emits the
 * dual light-plus/dark-plus token colors (flipped by the `.dark` root class)
 * and `.editor-file-viewer*` CSS paints the line-number gutter for both the
 * highlighted and the plain-text fallback paths. Plain text stays on screen
 * until the highlighter resolves — it already looks like the editor.
 */
function FilePreview({
	name,
	text,
	truncated,
	onBack,
}: {
	name: string;
	text: string;
	truncated: boolean;
	onBack: () => void;
}) {
	const { t } = useTranslation();
	const [html, setHtml] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setHtml(null);
		highlightFileToHtml(text, name)
			.then((next) => {
				if (!cancelled) setHtml(next);
			})
			.catch(() => {
				if (!cancelled) setHtml(null);
			});
		return () => {
			cancelled = true;
		};
	}, [text, name]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[color:var(--app-surface-divider)] px-1.5">
				<IconButton
					label={t("common.back")}
					onClick={onBack}
					tooltip={t("common.back")}
				>
					<ArrowLeftIcon className="size-3.5" />
				</IconButton>
				<FileTypeIcon name={name} className="size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{name}
				</span>
			</div>
			{truncated ? (
				<p className="shrink-0 px-3 pt-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{t("files.truncated")}
				</p>
			) : null}
			<div className="editor-file-viewer min-h-0 flex-1 overflow-auto">
				{html !== null ? (
					<div
						className="editor-file-viewer__highlight"
						// Shiki escapes the source text before wrapping it in token spans.
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				) : (
					<pre className="editor-file-viewer__plain">
						<code>
							{text.split("\n").map((line, index) => (
								<span key={index} className="line">
									{line || " "}
									{"\n"}
								</span>
							))}
						</code>
					</pre>
				)}
			</div>
		</div>
	);
}
