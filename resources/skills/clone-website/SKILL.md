---
name: clone-website
description: Reverse-engineer and rebuild one or more target websites as high-fidelity Next.js pages using NekoCode's native visible browser automation, a fixed structural extractor, extracted assets, component specifications, and scoped parallel builders. Invoke directly with /clone-website <url1> [url2 ...].
---

# Clone Website in NekoCode

Clone the URL or URLs in the user brief that follows this skill block. A URL is required; if none follows, ask for it before doing anything else. Only clone sites the user is authorized to inspect and reproduce. Do not collect credentials, private account data, or content behind access controls.

Read `references/workflow.md` completely before starting; it is the procedure. This file holds the rules it runs under, and wins on any conflict.

## Tools

- `browser_navigate` — open an http(s) URL in the visible browser panel and bind it to this session. Navigating to the URL already open reloads it; use that to load a rebuilt page.
- `browser_viewport` — set the CSS viewport (1440×900, 768×900, 390×844). It holds for every later call, across navigations, until changed.
- `browser_extract` — the fixed extractor: named elements → rects, own text, attributes, non-default computed styles (colors normalized), pseudo-elements, small inline SVGs. Use it for all structural evidence.
- `browser_evaluate` — arbitrary read-only JavaScript for what the extractor does not cover (asset inventories, stylesheet rules, library detection). It must never navigate: no `location.reload()`, no assigning `location.href`, no form submits.
- `browser_action` — click, hover, scroll, type, wait. Scroll before clicking. Never type secrets or submit forms that change anything.
- `website_clone_compare` — diff two saved extractions: `match: "text"` for source vs clone, `match: "path"` for two states of one page.
- `browser_screenshot` — optional second check; its result says whether the image is attached for the active model.
- `website_clone_scaffold` — copy the bundled Next.js template into a new workspace child directory.
- `website_clone_dev_server` — start/status/stop a project's dev server without blocking; returns the URL it actually printed.

Pass `saveTo` (under the artifact root) on every `browser_extract`, and on any `browser_evaluate` whose result is a research artifact. Never re-type a tool result with `write` — that doubles the cost and corrupts exact values.

Never claim a navigation, extraction, comparison, screenshot, build or check happened unless the tool or command succeeded.

## Project root

Choose one `<app-root>` before extraction:

1. If the workspace already has a compatible Next.js App Router project and the user clearly wants the clone there, use it, and run its `npm run build` once before changing anything.
2. Otherwise call `website_clone_scaffold` once with a new direct child directory named like `<hostname>-clone` (lowercase letters, digits, `.`, `_`, `-`). If it exists, ask before choosing another name. Then run `npm install` in it and check lightly: `node_modules/next` resolves, `node --version` meets `engines.node`, `src/app/layout.tsx` and `page.tsx` exist. Do not build the untouched template; it is validated when NekoCode is released.
3. Use the project's npm scripts — `npm run typecheck`, `npm run check` — never `npx next`.
4. Every write — code, assets, research artifacts, screenshots — goes under `<app-root>`. Tool paths are workspace-relative, so prefix them with `<app-root>/`.

Never copy the template by hand, and never initialize or overwrite the workspace root.

## Dev servers

Never start a dev server with `bash` or `powershell`: those wait for the command to exit, and a dev server never does, so the run hangs. Use `website_clone_dev_server`, navigate to the URL it returns plus the route, read compile errors from its `status`, and `stop` it when QA is done.

## Evidence

Structural evidence is the default and works with any model: `browser_extract` at every target viewport, saved as files, and `website_clone_compare` for every comparison. Screenshots never replace it. At QA, take one screenshot of the source: if its result says the image is attached, also compare screenshots of source and clone; if not, take no more.

## Builders

Builders are `task` workers, available in the delegate phase (request it with `switch_mode` once the foundation typechecks). Each gets its complete spec inline in `designSpec`, exact import paths and asset paths in `prompt`, and exactly its own component files in `writablePaths`.

- Finish the shared foundation yourself, sequentially, before any builder starts.
- Never let two builders — or a builder and you — write the same file. Routes, global CSS, layouts, shared icon modules, package manifests, lockfiles and research artifacts belong to the lead.
- Workers may have no shell. You run `npm run typecheck` after each completed batch and fix integration errors before dispatching more.
- A clone is not complete while `npm run check` fails in `<app-root>`.
- Leave no worker running when you leave the delegate phase. If the user declines the switch, build from the same specs yourself.

## Completion

Report as `references/workflow.md` describes: source URL → route mapping, `<app-root>`, what was created, commands actually run and their results, QA per viewport with remaining differences, and known gaps. Keep existing routes and user files unless the user approved replacing a specific path.

## Attribution

Adapted from `JCodesMore/ai-website-cloner-template` 0.5.0 under MIT. See `licenses/WebsiteCloner-LICENSE.txt` and the repository third-party notices.
