export function SettingsRow({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 py-2.5">
			<div className="flex min-w-0 flex-col">
				<span className="text-[length:var(--app-font-size-ui,12px)]">{label}</span>
				{hint ? (
					<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
						{hint}
					</span>
				) : null}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}
