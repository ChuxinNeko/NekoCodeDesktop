// FILE: types.ts
// Purpose: Props every review tab shares, and the commit draft that survives tab switches.
// Layer: Review workbench

import type { ReactNode } from "react";
import type { RepoStatus } from "../../../../shared/git";
import type { DiffPrefs } from "./hooks";

export type ReviewTab = "changes" | "history" | "compare";

export interface CommitDraft {
	summary: string;
	description: string;
	amend: boolean;
	/** Paths the user unticked; a new file is ticked until they say otherwise. */
	excluded: string[];
}

export const EMPTY_DRAFT: CommitDraft = { summary: "", description: "", amend: false, excluded: [] };

export interface TabProps {
	cwd: string;
	status: RepoStatus;
	prefs: DiffPrefs;
	onPrefs: (next: DiffPrefs) => void;
	/** The tab switcher, drawn at the top of the tab's sidebar. */
	tabs: ReactNode;
	/** Reload status and everything derived from it after a change. */
	onChanged: () => Promise<void>;
	onError: (message: string) => void;
	onNotice: (message: string) => void;
	onSelectTab: (tab: ReviewTab) => void;
}
