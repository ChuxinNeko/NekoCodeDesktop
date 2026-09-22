import { Dialog } from "@base-ui/react/dialog";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { HostDirectoryListing } from "../../../shared/files";
import { api, errorMessage } from "../api";
import { useTranslation } from "../i18n";
import { ArrowUpIcon, DeviceHomeIcon, FolderIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "./chat/composerPickerStyles";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type PickRequest = {
	nonce: number;
	initialPath?: string;
	resolve: (path: string | null) => void;
};

const PickerContext = createContext<((initialPath?: string) => Promise<string | null>) | null>(null);

export function useHostDirectoryPicker(): (initialPath?: string) => Promise<string | null> {
	const pick = useContext(PickerContext);
	if (!pick) throw new Error("useHostDirectoryPicker must be used inside HostDirectoryPickerProvider");
	return pick;
}

export function HostDirectoryPickerProvider({ children }: { children: React.ReactNode }) {
	const [request, setRequest] = useState<PickRequest | null>(null);
	const requestRef = useRef<PickRequest | null>(null);
	const nonceRef = useRef(0);
	const isElectron = api.runtime === "electron";

	const pick = useCallback(
		(initialPath?: string): Promise<string | null> => {
			if (isElectron) return api.pickDirectory();
			return new Promise<string | null>((resolve) => {
				requestRef.current?.resolve(null);
				const next: PickRequest = { nonce: ++nonceRef.current, resolve };
				if (initialPath !== undefined) next.initialPath = initialPath;
				requestRef.current = next;
				setRequest(next);
			});
		},
		[isElectron],
	);

	const settle = useCallback((nonce: number, path: string | null) => {
		const current = requestRef.current;
		if (current?.nonce !== nonce) return;
		requestRef.current = null;
		setRequest(null);
		current.resolve(path);
	}, []);

	useEffect(
		() => () => {
			requestRef.current?.resolve(null);
			requestRef.current = null;
		},
		[],
	);

	return (
		<PickerContext.Provider value={pick}>
			{children}
			{request ? (
				<HostDirectoryPickerDialog
					key={request.nonce}
					initialPath={request.initialPath}
					onDone={(path) => settle(request.nonce, path)}
				/>
			) : null}
		</PickerContext.Provider>
	);
}

function HostDirectoryPickerDialog({
	initialPath,
	onDone,
}: {
	initialPath?: string;
	onDone: (path: string | null) => void;
}) {
	const { t } = useTranslation();
	const [listing, setListing] = useState<HostDirectoryListing | null>(null);
	const [draft, setDraft] = useState(initialPath ?? api.homeDir);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);

	const navigate = useCallback((path: string) => {
		const gen = ++generation.current;
		setListing(null);
		setLoading(true);
		setError(null);
		api
			.directoryList(path)
			.then((next) => {
				if (generation.current !== gen) return;
				setListing(next);
				setDraft(next.path);
				setLoading(false);
			})
			.catch((cause: unknown) => {
				if (generation.current !== gen) return;
				setError(errorMessage(cause));
				setLoading(false);
			});
	}, []);

	useEffect(() => {
		navigate(initialPath ?? api.homeDir);
		return () => {
			generation.current++;
		};
	}, [initialPath, navigate]);

	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) onDone(null);
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-[60] min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					className={cn(
						"fixed left-1/2 top-1/2 z-[60] flex max-h-[min(34rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
						"flex-col gap-3 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						"w-[32rem] max-w-[calc(100vw-3rem)]",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<Dialog.Title className="shrink-0 text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
						{t("directoryPicker.title")}
					</Dialog.Title>
					<p className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{t("directoryPicker.hostHint")}
					</p>

					<div className="flex shrink-0 items-center gap-2">
						<Input
							className="min-w-0 flex-1"
							aria-label={t("directoryPicker.path")}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && draft.trim()) navigate(draft.trim());
							}}
						/>
						<Button
							size="sm"
							variant="subtle"
							disabled={!draft.trim()}
							onClick={() => navigate(draft.trim())}
						>
							{t("directoryPicker.go")}
						</Button>
						<Button
							size="icon-xs"
							variant="chrome-outline"
							title={t("directoryPicker.home")}
							disabled={!api.homeDir}
							onClick={() => navigate(api.homeDir)}
						>
							<DeviceHomeIcon className="size-3.5" />
						</Button>
						<Button
							size="sm"
							variant="chrome-outline"
							disabled={!listing}
							onClick={() => listing && navigate(listing.root)}
						>
							{t("directoryPicker.root")}
						</Button>
						<Button
							size="icon-xs"
							variant="chrome-outline"
							title={t("directoryPicker.parent")}
							disabled={!listing?.parent}
							onClick={() => listing?.parent && navigate(listing.parent)}
						>
							<ArrowUpIcon className="size-3.5" />
						</Button>
					</div>

					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border border-[color:var(--app-surface-divider)]">
						{loading ? (
							<p className="px-3 py-6 text-center text-xs text-muted-foreground">
								{t("common.loading")}
							</p>
						) : error ? (
							<p className="px-3 py-6 text-center text-xs text-destructive">{error}</p>
						) : listing && listing.directories.length === 0 ? (
							<p className="px-3 py-6 text-center text-xs text-muted-foreground">
								{t("directoryPicker.empty")}
							</p>
						) : (
							listing?.directories.map((entry) => (
								<button
									key={entry.path}
									type="button"
									onClick={() => navigate(entry.path)}
									className="flex items-center gap-2 px-3 py-1.5 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors hover:bg-[var(--sidebar-accent)]"
								>
									<FolderIcon className="size-3.5 shrink-0 opacity-80" />
									<span className="min-w-0 flex-1 truncate">{entry.name}</span>
								</button>
							))
						)}
					</div>
					{listing?.truncated ? (
						<p className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
							{t("directoryPicker.truncated")}
						</p>
					) : null}

					<div className="flex shrink-0 items-center justify-end gap-2">
						<Button onClick={() => onDone(null)} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button
							size="sm"
							disabled={!listing || loading}
							onClick={() => listing && onDone(listing.path)}
						>
							{t("directoryPicker.selectCurrent")}
						</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
