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
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
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
