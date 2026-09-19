---
name: clone-website
description: Reverse-engineer and rebuild one or more target websites as high-fidelity Next.js pages using NekoCode's native visible browser automation, extracted assets, component specifications, and scoped parallel builders. Invoke directly with /clone-website <url1> [url2 ...].
---

# Clone Website in NekoCode

Clone the URL or URLs in the user brief that follows this skill block. A URL is required; if none follows, ask for it before doing anything else. Only clone sites the user is authorized to inspect and reproduce. Do not collect credentials, private account data, or content hidden behind access controls.

Read `references/upstream-workflow.md` and `references/inspection-guide.md` completely before implementation. Follow the upstream workflow except where this file replaces its platform assumptions. These NekoCode rules win on every conflict.

## Native tools

Use NekoCode's built-in tools rather than Browser MCP:

- `browser_navigate` opens the target in the visible right-side browser panel and waits for its page guest.
- `browser_viewport` sets the emulated CSS viewport.
- `browser_evaluate` runs a JavaScript expression in the inspected page and returns bounded JSON/text. Use it for DOM, computed-style, content, asset, and interaction-model extraction.
- `browser_screenshot` is optional and only for an explicitly image-capable workflow or a user-requested human reference; the default cloning workflow does not call it.
- `browser_action` performs click, hover, scroll, text entry, or a bounded wait.
- `website_clone_scaffold` copies NekoCode's bundled Next.js template into a new workspace subdirectory without overwriting files.

Never claim a browser action, screenshot, visual comparison, or build happened unless the corresponding tool or command succeeded.

## Screenshot-free default

Default to a text-and-geometry workflow that works with non-multimodal models. Do not call `browser_screenshot`, read generated PNGs, or require screenshots in builder prompts unless the user explicitly asks for screenshots and the active model can inspect images.

At every target viewport, use `browser_evaluate` to capture structured evidence instead:

- viewport and document metrics: `innerWidth`, `innerHeight`, `devicePixelRatio`, scroll height, overflow, and fixed/sticky elements
- section topology: semantic role, stable selector, DOM order, bounding rectangle, visibility, z-index, and parent/child relationships
- exact computed styles for relevant elements, including typography, color, spacing, dimensions, grid/flex, borders, shadows, opacity, transforms, transitions, and responsive changes
- verbatim text, links, accessible names, image/video/SVG URLs and intrinsic dimensions
- interaction state before and after scroll, click, hover, focus, tab changes, menus, and accordions

Persist these findings as focused JSON or Markdown research files under the target's artifact root. Keep each extraction bounded and section-specific rather than dumping the whole DOM.

For final QA, run the same structured extractor against the source page and the local clone at matching viewports. Compare section order, bounding rectangles, computed styles, content, assets, and interaction-state transitions. Record numeric/style discrepancies and fix them. This structural comparison is the required QA path; pixel or screenshot comparison is optional.

These rules replace every upstream requirement that calls screenshots mandatory, a master reference, a builder input, a pre-dispatch checklist item, or the only evidence of visual QA. Builders receive structured component specifications and asset paths instead of screenshots.

## Project root

Choose one `<app-root>` before extraction:

1. If the current workspace already has a compatible Next.js App Router project and the user clearly wants to add the clone there, use that project.
2. Otherwise create a new direct child directory of the workspace. Derive a readable name such as `<hostname>-clone`; do not use an absolute path, `.` or `..`. If it already exists, ask before choosing another name. Call `website_clone_scaffold` once with that directory.
3. In a newly scaffolded project, run `npm install` and then lightweight checks only: `package.json`/`package-lock.json` exist, `node_modules/next` resolves, Node meets the template's requirement, and `src/app/layout.tsx`/`page.tsx` are present. Do not run a baseline `npm run build` on the known-good bundled template — that cost belongs to NekoCode CI/release validation. For an existing user project, run its baseline `npm run build` before modifying it. In all cases use the template's npm scripts—especially `npm run check` and `npm run build`—instead of invoking `npx next`; the scripts establish the required production environment even when NekoCode itself is running in development.
4. Perform all generated-code writes, asset downloads, research artifacts, screenshots, and verification under `<app-root>`. Browser screenshot paths are workspace-relative, so prefix them with `<app-root>/`.

Never copy the bundled template manually and never initialize or overwrite the workspace root as a fallback.

## Browser procedure

Use the visible native browser for the upstream reconnaissance and QA phases:

1. `browser_navigate` each normalized HTTP(S) URL.
2. Inspect desktop at 1440×900, tablet at 768×900, and mobile at 390×844 with `browser_viewport`, verify the reported dimensions, then capture section-specific structured data with `browser_evaluate`.
3. Use `browser_evaluate` for the upstream asset-discovery and computed-style scripts. Keep each result focused enough to fit the bounded tool output; inspect one section at a time.
4. Use `browser_action` to scroll before clicking, then test clicks, hovers, tabs, menus, and state changes. Never type secrets or submit destructive forms.
5. Save structured JSON/Markdown inspection artifacts under the planned namespaced research directory; do not generate screenshot files by default.
6. During structured QA, navigate between the source and the exact local route printed by the running dev server, run matching extractors at matching viewports, and do not guess a localhost port.

## NekoCode builder model

NekoCode workers share one workspace; they do not use Git worktrees or branches. Replace the upstream worktree/merge instructions with these rules:

- Finish the shared foundation sequentially in the lead session.
- Dispatch builders only for declared, non-overlapping component paths. Give every worker the full component specification inline and the exact writable paths.
- Workers write directly to their assigned paths. There is no branch merge step.
- Ordinary workers may not have shell access. The lead runs typecheck/build after completed batches and fixes integration errors before continuing. Before reporting completion, the lead runs `npm run check` (lint + typecheck + production build) in `<app-root>`; a clone is not complete while that fails.
- Do not leave a background worker running when changing away from the delegation phase.
- Never let parallel builders edit the same route, global stylesheet, layout, shared icon file, package manifest, lockfile, or research artifact.

All upstream requirements for output isolation, real assets/content, interaction discovery, exact computed styles, component specs, route preservation, responsive inspection, and final QA remain in force, subject to the screenshot-free replacements above.

## Completion

Report the source URL to local route mapping, `<app-root>`, sections/components/specs/assets created, commands actually run, build status, structured QA performed and any optional visual QA, and known discrepancies. Keep existing routes and user files unless the user explicitly approved replacing a specific path.

## Attribution

Adapted from `JCodesMore/ai-website-cloner-template` 0.5.0 under MIT. See `licenses/WebsiteCloner-LICENSE.txt` and the repository third-party notices.
