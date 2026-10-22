import { DEFAULT_APP_PREFERENCES, isAutoRetryCount } from "../shared/preferences";

let source: () => number | undefined = () => undefined;

export function configureAgentRetry(read: () => number | undefined): void { source = read; }

export function currentAutoRetryCount(): number {
	const count = source();
	return isAutoRetryCount(count) ? count : DEFAULT_APP_PREFERENCES.autoRetryCount;
}

/** Session overrides leave the user's kernel/project configuration on disk intact. */
export function currentAgentRetrySettings() {
	const maxRetries = currentAutoRetryCount();
	return { retry: { enabled: maxRetries > 0, maxRetries } };
}
