import { useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AppearanceSettings } from "./AppearanceSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ModelSettings } from "./ModelSettings";
import { ArrowLeftIcon } from "../../lib/icons";

const SECTIONS = [
	{ id: "appearance", label: "Appearance" },
	{ id: "models", label: "Models" },
	{ id: "github", label: "GitHub" },
	{ id: "about", label: "About" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsPage({ onClose }: { onClose: () => void }) {
	const [section, setSection] = useState<SectionId>("appearance");

	return (
		<div className="flex min-h-0 flex-1">
			<nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-[color:var(--app-surface-divider)] p-2">
				<div className="flex items-center gap-1 px-1 pb-2">
					<Button onClick={onClose} size="icon-xs" variant="ghost">
						<ArrowLeftIcon className="size-3.5" />
					</Button>
					<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">Settings</span>
				</div>
				{SECTIONS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						onClick={() => setSection(entry.id)}
						className={cn(
							"flex h-[var(--app-density-row-height,1.75rem)] items-center rounded-md px-2 text-left text-[length:var(--app-font-size-ui,12px)] transition-colors",
							section === entry.id
								? "bg-[var(--sidebar-selected)] text-foreground"
								: "text-foreground/95 hover:bg-[var(--sidebar-accent)]",
						)}
					>
						{entry.label}
					</button>
				))}
			</nav>

			<div className="min-h-0 flex-1 overflow-y-auto p-5">
				<div className="mx-auto flex w-full max-w-[42rem] flex-col gap-4">
					<h2 className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
						{SECTIONS.find((entry) => entry.id === section)?.label}
					</h2>
					{section === "appearance" ? <AppearanceSettings /> : null}
					{section === "models" ? <ModelSettings /> : null}
					{section === "github" ? <GitHubSettings /> : null}
					{section === "about" ? (
						<div className="flex flex-col gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							<p>
								NekoCode Desktop runs the PI agent core in the Electron main process and
								streams its events to this renderer.
							</p>
							<p>
								The PI source lives in <code>vendor/pi</code> and is built with{" "}
								<code>bun run pi:setup</code>.
							</p>
							<p>
								Tools run with the permissions of this app; the execution mode picker only
								restricts which tools are exposed to the model.
							</p>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
