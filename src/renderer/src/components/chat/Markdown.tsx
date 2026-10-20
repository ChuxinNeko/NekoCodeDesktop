import { isValidElement, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { MarkdownLink } from "./WebSources";
import { MermaidDiagram } from "./MermaidDiagram";
import { OpenUIBlock } from "./OpenUIBlock";

// Stable links use the application's safe opener instead of navigating Electron.

/** One message renderer for the main transcript and auxiliary-agent panels. */
export const Markdown = memo(function Markdown({ text, user, streaming = false }: { text: string; user?: boolean; streaming?: boolean }) {
	const components = useMemo<Components>(() => ({
		a: MarkdownLink,
		pre: ({ children, node: _node, ...props }) => {
			if (!user && isValidElement<{ className?: string; children?: ReactNode }>(children) && /(?:^|\s)language-openui(?:\s|$)/i.test(children.props.className ?? "")) {
				return <OpenUIBlock source={String(children.props.children ?? "").replace(/\n$/, "")} streaming={streaming} />;
			}
			if (!user && isValidElement<{ className?: string; children?: ReactNode }>(children) && /(?:^|\s)language-mermaid(?:\s|$)/i.test(children.props.className ?? "")) {
				return <MermaidDiagram source={String(children.props.children ?? "").replace(/\n$/, "")} streaming={streaming} />;
			}
			return <pre {...props}>{children}</pre>;
		},
	}), [user, streaming]);
	return (
		<div className={cn("chat-markdown", user && "chat-markdown--user")}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
		</div>
	);
});
