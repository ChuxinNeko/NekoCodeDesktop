// FILE: NameDialog.tsx
// Purpose: A small modal that asks for one name — a new branch, a renamed branch.
// Layer: Review workbench

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";

export function NameDialog({
	open,
	title,
	description,
	placeholder,
	initial = "",
	confirmLabel,
	onSubmit,
	onClose,
}: {
	open: boolean;
	title: ReactNode;
	description?: ReactNode;
	placeholder: string;
	initial?: string;
	confirmLabel: string;
	/** Rejecting keeps the dialog open and shows the message. */
	onSubmit: (name: string) => Promise<void>;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const [name, setName] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setName(initial);
		setError(null);
		setBusy(false);
		const timer = window.setTimeout(() => {
			input.current?.focus();
			input.current?.select();
		}, 30);
		return () => window.clearTimeout(timer);
	}, [open, initial]);

	const submit = async () => {
		const value = name.trim();
		if (!value || busy) return;
		setBusy(true);
		setError(null);
		try {
			await onSubmit(value);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	};

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onClose();
			}}
			title={title}
			description={description}
			footer={
				<>
					<Button onClick={onClose} size="sm" variant="chrome-outline" disabled={busy}>
						{t("common.cancel")}
					</Button>
					<Button onClick={() => void submit()} size="sm" disabled={busy || !name.trim()}>
						{confirmLabel}
					</Button>
				</>
			}
		>
			<input
				ref={input}
				value={name}
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void submit();
					}
				}}
				placeholder={placeholder}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				className="h-8 w-full rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2 font-mono text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground/60 focus:border-[color:var(--color-border-focus)]"
			/>
			{error ? <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</p> : null}
		</ConfirmDialog>
	);
}
