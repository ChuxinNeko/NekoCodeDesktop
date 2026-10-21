import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/** Shared by desktop and mobile Markdown surfaces; ordinary code stays literal. */
export const markdownRemarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkMath];
// Model output and repository content are untrusted. Never enable KaTeX commands
// that load remote resources or inject HTML. Invalid/unfinished TeX stays visible.
export const markdownRehypePlugins: Options["rehypePlugins"] = [[rehypeKatex, { trust: false }]];
