import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "../../i18n";

/** Release bodies are untrusted Markdown. Render text, never HTML or remote images. */
export function ReleaseNotes({ notes, onOpen }: { notes: string; onOpen: (url: string) => void }) {
	const { t } = useTranslation();
	if (!notes.trim()) return <p className="text-xs text-muted-foreground">{t("updates.noNotes")}</p>;
	return (
		<div className="chat-markdown min-w-0 break-words text-xs leading-relaxed [overflow-wrap:anywhere]">
			<ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
				img: () => null,
				a: ({ href, children }) => href && /^https?:\/\//i.test(href)
					? <a href={href} onClick={(event) => { event.preventDefault(); onOpen(href); }}>{children}</a>
					: <span>{children}</span>,
			}}>{notes}</ReactMarkdown>
		</div>
	);
}
