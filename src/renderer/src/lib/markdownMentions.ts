import type { Element, Root, RootContent } from "hast";

export interface MarkdownMention { id: string; name: string }

/** Highlight roster mentions in prose, leaving code, links and math literal. */
export function markdownMentions(mentions: readonly MarkdownMention[]) {
	const members = new Map(mentions.map(member => [member.name.toLocaleLowerCase(), member.id]));
	if (!members.has("all")) members.set("all", "all");
	const names = [...members.keys()].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@.+-])@(${names.join("|")})(?![\\p{L}\\p{N}_-])`, "giu");
	return () => (tree: Root) => {
		const walk = (parent: Root | Element) => {
			if (parent.type === "element" && (["code", "pre", "a", "script", "style"].includes(parent.tagName) ||
				String(parent.properties.className ?? "").includes("katex"))) return;
			const children: RootContent[] = [];
			for (const child of parent.children) {
				if (child.type !== "text") {
					if (child.type === "element") walk(child);
					children.push(child);
					continue;
				}
				let cursor = 0;
				for (const match of child.value.matchAll(pattern)) {
					const start = match.index! + match[1].length;
					if (start > cursor) children.push({ type: "text", value: child.value.slice(cursor, start) });
					const value = `@${match[2]}`;
					children.push({ type: "element", tagName: "span", properties: {
						className: ["team-mention"], "data-team-mention": members.get(match[2].toLocaleLowerCase()),
					}, children: [{ type: "text", value }] });
					cursor = start + value.length;
				}
				if (cursor < child.value.length) children.push({ type: "text", value: child.value.slice(cursor) });
			}
			parent.children = children;
		};
		walk(tree);
	};
}
