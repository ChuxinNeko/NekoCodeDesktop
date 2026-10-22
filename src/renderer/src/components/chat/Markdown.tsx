import { isValidElement, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { markdownRemarkPlugins, markdownRehypePlugins } from "../../lib/markdownPlugins";
import { cn } from "../../lib/utils";
import { MarkdownLink } from "./WebSources";
import { MermaidDiagram } from "./MermaidDiagram";
import { OpenUIBlock } from "./OpenUIBlock";

// Stable links use the application's safe opener instead of navigating Electron.

/** One message renderer for the main transcript and auxiliary-agent panels. */
export const Markdown = memo(function Markdown({ text, user, streaming = false, documentId }: { text: string; user?: boolean; streaming?: boolean; documentId?: string }) {
	const components = useMemo<Components>(() => ({
		a: MarkdownLink,
		pre: ({ children, node, ...props }) => {
			if (!user && isValidElement<{ className?: string; children?: ReactNode }>(children) && /(?:^|\s)language-openui(?:-lang|-app)?(?:\s|$)/i.test(children.props.className ?? "")) {
				return <OpenUIBlock source={String(children.props.children ?? "").replace(/\n$/, "")} streaming={streaming} documentId={documentId} offset={node?.position?.start.offset ?? 0} />;
			}
			if (!user && isValidElement<{ className?: string; children?: ReactNode }>(children) && /(?:^|\s)language-mermaid(?:\s|$)/i.test(children.props.className ?? "")) {
				return <MermaidDiagram source={String(children.props.children ?? "").replace(/\n$/, "")} streaming={streaming} />;
			}
			return <pre {...props}>{children}</pre>;
		},
	}), [user, streaming, documentId]);
	return (
		<div className={cn("chat-markdown", user && "chat-markdown--user")}>
			<ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={components}>{text}</ReactMarkdown>
		</div>
	);
});
