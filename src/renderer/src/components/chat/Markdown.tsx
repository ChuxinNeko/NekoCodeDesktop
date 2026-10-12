import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { MarkdownLink } from "./WebSources";

// Stable links use the application's safe opener instead of navigating Electron.
const MARKDOWN_COMPONENTS = { a: MarkdownLink };

/** One message renderer for the main transcript and auxiliary-agent panels. */
export const Markdown = memo(function Markdown({ text, user }: { text: string; user?: boolean }) {
	return (
		<div className={cn("chat-markdown", user && "chat-markdown--user")}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
		</div>
	);
});
