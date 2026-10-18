import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubPage } from "../../../../shared/github-client";
import { errorMessage } from "../../api";

/** Ignore late responses after a repo, filter, or selected item changes. */
export function useGitHubResource<T>(key: string, loader: () => Promise<T>) {
  const latest = useRef(loader);
  latest.current = loader;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    loading: boolean;
    error: string | null;
  }>({ key, data: null, loading: true, error: null });
  useEffect(() => {
    let active = true;
    setState({ key, data: null, loading: true, error: null });
    void latest.current().then(
      (data) => {
        if (active) setState({ key, data, loading: false, error: null });
      },
      (cause) => {
        if (active)
          setState({
            key,
            data: null,
            loading: false,
            error: errorMessage(cause),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [key, revision]);
  const reload = useCallback(() => setRevision((r) => r + 1), []);
  return {
    ...(state.key === key ? state : { data: null, loading: true, error: null }),
    reload,
  };
}

export function useGitHubPages<T>(
  key: string,
  loader: (page: number) => Promise<GitHubPage<T>>,
) {
  const latest = useRef(loader);
  latest.current = loader;
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    items: T[];
    page: number;
    hasNext: boolean;
    loading: boolean;
    error: string | null;
  }>({ key, items: [], page: 0, hasNext: false, loading: true, error: null });
  useEffect(() => {
    const version = ++generation.current;
    loadingRef.current = true;
    setState({
      key,
      items: [],
      page: 0,
      hasNext: false,
      loading: true,
      error: null,
    });
    void latest
      .current(1)
      .then(
        (result) => {
          if (version === generation.current)
            setState({ key, ...result, loading: false, error: null });
        },
        (cause) => {
          if (version === generation.current)
            setState({
              key,
              items: [],
              page: 0,
              hasNext: false,
              loading: false,
              error: errorMessage(cause),
            });
        },
      )
      .finally(() => {
        if (version === generation.current) loadingRef.current = false;
      });
    return () => {
      generation.current++;
    };
  }, [key, revision]);
  const more = async () => {
    if (loadingRef.current || !state.hasNext || state.key !== key) return;
    const version = generation.current;
    loadingRef.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const next = await latest.current(state.page + 1);
      if (version === generation.current)
        setState((s) => ({
          key,
          items: [...s.items, ...next.items],
          page: next.page,
          hasNext: next.hasNext,
          loading: false,
          error: null,
        }));
    } catch (cause) {
      if (version === generation.current)
        setState((s) => ({ ...s, loading: false, error: errorMessage(cause) }));
    } finally {
      if (version === generation.current) loadingRef.current = false;
    }
  };
  const reload = useCallback(() => setRevision((r) => r + 1), []);
  return {
    ...(state.key === key
      ? state
      : { items: [], page: 0, hasNext: false, loading: true, error: null }),
    reload,
    more,
  };
}

export function useGitHubMutation() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      await operation();
      setSuccess(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    success,
    run,
    clear: () => {
      setError(null);
      setSuccess(false);
    },
  };
}
