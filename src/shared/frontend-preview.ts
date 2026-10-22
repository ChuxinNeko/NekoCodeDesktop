/** Files that indicate a user-facing web application changed in this turn. */
export function frontendFiles(paths: readonly string[]): string[] {
	return paths.filter(path => {
		const normalized = path.replace(/\\/g, "/");
		if (/(?:^|\/)(?:node_modules|dist|build|\.next|test|tests|__tests__)(?:\/|$)|\.(?:test|spec|stories)\./i.test(normalized)) return false;
		return /\.(?:html?|tsx|jsx|vue|svelte|astro|css|scss|sass|less)$/i.test(normalized) ||
			(/\.(?:js|ts|mjs)$/i.test(normalized) && (/(?:^|\/)(?:components|pages|views|client|frontend|web|app)\//i.test(normalized) || /(?:^|\/)(?:script|app|client)\.(?:m?js)$/i.test(normalized)));
	});
}
