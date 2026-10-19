// FILE: hooks.ts
// Purpose: State hooks for the review workbench: repository status that keeps
//          itself fresh, remembered preferences, and container sizing.
// Layer: Renderer hooks

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { RepoStatus } from "../../../../shared/git";
import { api, errorMessage } from "../../api";

/** How often the status is re-read while the panel is on screen. */
const POLL_MS = 10_000;

export interface RepoState {
	status: RepoStatus | null;
	loading: boolean;
	error: string | null;
	setError: (message: string | null) => void;
	refresh: () => Promise<void>;
}

/**
 * The repository's status, re-read on mount, when the window regains focus, and on a
 * slow timer, so edits made by the agent or a terminal show up without a click. An
 * unchanged answer keeps the previous object, so nothing downstream re-renders or
 * re-fetches a diff for no reason.
 */
export function useRepoStatus(cwd: string | null): RepoState {
	const [status, setStatus] = useState<RepoStatus | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const latest = useRef(0);
	const signature = useRef("");

	const refresh = useCallback(async () => {
		if (!cwd) return;
		const ticket = ++latest.current;
		setLoading(true);
		try {
			const next = await api.gitStatus(cwd);
			if (ticket !== latest.current) return;
			const key = JSON.stringify(next);
			if (key !== signature.current) {
				signature.current = key;
				setStatus(next);
			}
		} catch (cause) {
			if (ticket === latest.current) setError(errorMessage(cause));
		} finally {
			if (ticket === latest.current) setLoading(false);
		}
	}, [cwd]);

	useEffect(() => {
		latest.current += 1;
		signature.current = "";
		setStatus(null);
		setError(null);
		if (!cwd) return;
		void refresh();
		const onFocus = () => void refresh();
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, POLL_MS);
		window.addEventListener("focus", onFocus);
		return () => {
			window.removeEventListener("focus", onFocus);
			window.clearInterval(timer);
			latest.current += 1;
		};
	}, [cwd, refresh]);

	return { status, loading, error, setError, refresh };
}

/** State mirrored into localStorage; a value `accept` rejects falls back to the default. */
export function usePersistentState<T>(
	key: string,
	initial: T,
	accept: (value: unknown) => value is T,
): [T, (next: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			if (raw !== null) {
				const parsed: unknown = JSON.parse(raw);
				if (accept(parsed)) return parsed;
			}
		} catch {
			// unreadable or unavailable storage: use the default
		}
		return initial;
	});
	const set = useCallback(
		(next: T) => {
			setValue(next);
			try {
				localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// the choice just will not outlive this session
			}
		},
		[key],
	);
	return [value, set];
}

export interface DiffPrefs {
	mode: "unified" | "split";
	ignoreWhitespace: boolean;
}

const DEFAULT_DIFF_PREFS: DiffPrefs = { mode: "unified", ignoreWhitespace: false };

function isDiffPrefs(value: unknown): value is DiffPrefs {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (candidate.mode === "unified" || candidate.mode === "split") && typeof candidate.ignoreWhitespace === "boolean";
}

export function useDiffPrefs(): [DiffPrefs, (next: DiffPrefs) => void] {
	return usePersistentState("nekocode:review:diff", DEFAULT_DIFF_PREFS, isDiffPrefs);
}

/** The element's width, kept current as it is resized. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		setWidth(element.getBoundingClientRect().width);
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) setWidth(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/**
 * Runs `load` whenever `deps` change and ignores any answer that arrives after the
 * next request began. While only `deps` change, the previous answer stays on screen
 * (a refresh should not flash); when `identity` changes, it is dropped (a different
 * file's diff must never sit under the new file's name).
 */
export function useAsync<T>(
	load: (() => Promise<T>) | null,
	deps: readonly unknown[],
	identity = "",
): { data: T | null; loading: boolean; error: string | null } {
	const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
		data: null,
		loading: load !== null,
		error: null,
	});
	const seen = useRef(identity);
	useEffect(() => {
		const sameSubject = seen.current === identity;
		seen.current = identity;
		if (!load) {
			setState({ data: null, loading: false, error: null });
			return;
		}
		let cancelled = false;
		setState((current) => ({ data: sameSubject ? current.data : null, loading: true, error: null }));
		load().then(
			(data) => {
				if (!cancelled) setState({ data, loading: false, error: null });
			},
			(cause: unknown) => {
				if (!cancelled) setState({ data: null, loading: false, error: errorMessage(cause) });
			},
		);
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the caller lists what `load` depends on
	}, deps);
	return state;
}
