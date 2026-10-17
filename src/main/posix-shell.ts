/** Text as one POSIX shell word. Never interpolate model-controlled text unquoted. */
export function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function shellQuotePath(path: string): string {
	return path === "~" ? "~" : path.startsWith("~/") ? `~/${shellQuote(path.slice(2))}` : shellQuote(path);
}
