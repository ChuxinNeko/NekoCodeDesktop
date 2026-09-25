# Clone Website — Workflow

The full procedure behind `/clone-website`. `SKILL.md` holds the rules; this file holds the steps. Every path below is relative to `<app-root>`.

You are a foreman walking the job site: inspect one section, write its specification to a file, hand that file to a builder, move on to the next section while the builder works. Extraction is meticulous and leaves auditable artifacts; construction runs alongside it.

## Scope defaults

Unless the user says otherwise:

- **Fidelity:** exact — colors, spacing, typography, motion, every interactive state.
- **In scope:** layout and styling, component structure, interactions, responsive behavior, mock data where content is per-session.
- **Out of scope:** real backend, authentication, real-time features, SEO work, accessibility audit.
- **Customization:** none. Match first; the user customizes later.

## 0. Output plan

Before touching the browser, write `docs/research/OUTPUT_PLAN.md` with one row per target URL:

| Field | Rule |
|---|---|
| `<site-key>` | Hostname, dots → `-`, plus `-<port>` for a non-default port: `www-example-com` |
| `<page-key>` | Path segments joined with `-`, `root` for `/`: `/docs/intro` → `docs-intro` |
| Route | First clone into an untouched template: `src/app/page.tsx` (`/`). Otherwise the source pathname: `src/app/docs/intro/page.tsx`. Escape segments that App Router would read as syntax: a leading `_` or `@`, `(…)`, `[…]`. |
| Artifact root | `docs/research/<site-key>/<page-key>/` |
| Component root | `src/components/sites/<site-key>/<page-key>/`, shared same-site pieces in `…/<site-key>/shared/` |
| Asset root | `public/sites/<site-key>/<page-key>/`, shared same-site assets in `public/sites/<site-key>/shared/` |
| Downloader | `scripts/download-assets-<site-key>-<page-key>.mjs` |

Then:

- Inventory existing `src/app/**/page.tsx`, `src/components/sites/`, `docs/research/`, `public/sites/`. Tell the untouched scaffold apart from existing clones or user work.
- If two targets produce the same key, suffix the later one `-2`. If a planned route already exists, ask: update it, choose another route, or skip.
- URLs that differ only by query or fragment share a route; decide explicitly whether they are one page or states of one page.
- Targets from different origins may need conflicting fonts, globals and layouts. Ask whether the user wants separate app roots (recommended) or one app with route-scoped styling. Never mix global foundations silently.

## 1. Reconnaissance

Navigate to the target. Save every result with `saveTo` under the artifact root; never paste extraction output back through `write`.

**Global extraction** (desktop, 1440×900) with `browser_evaluate`:

- **Fonts:** `<link>` and `@font-face` sources, and the computed `fontFamily`/weights/styles actually used by headings, body, labels, code.
- **Colors:** the palette used across the page. Map it to the template's shadcn tokens (`background`, `foreground`, `primary`, `muted`, …) where it fits.
- **Meta:** title, description, favicons, OG image, theme color.
- **Stack signals:** `__NEXT_DATA__`, `__NUXT__`, `ng-version`; Tailwind-like class names; GSAP, Framer Motion, Lottie, `<canvas>`, `<video>`.
- **Scroll model:** smooth-scroll libraries (`.lenis`, `.locomotive-scroll`, custom scroll containers), `scroll-snap-type`, `position: sticky`, `animation-timeline`.
- **Assets:** every `<img>` (currentSrc, natural size, parent, position, z-index — layered compositions matter), `<video>` (src, poster, autoplay/loop/muted), CSS `background-image` URLs, inline SVG count, favicons. Save as `assets.json`.

**Topology.** `browser_extract` on `body` with `maxDepth: 3` → `extract/topology-1440.json`. From it, write `PAGE_TOPOLOGY.md`: every section top to bottom with a working name and a stable selector, fixed/sticky overlays versus flow content, the scroll container and column structure, z-index layers, and each section's **interaction model**.

**Interaction sweep.** This is the step that separates a living clone from a screenshot. For every section:

1. **Scroll first, click second.** Extract the section, scroll past it in steps with `browser_action`, and extract again. If anything changed, the section is scroll-driven — find the mechanism (IntersectionObserver, scroll listener, sticky, snap, `animation-timeline`) before touching anything else.
2. Only then **click** every tab, pill, toggle, accordion and menu trigger; **hover** buttons, links, cards, images; **focus** inputs.
3. For each state change: `browser_extract` before → act → `browser_extract` after, both saved, then `website_clone_compare` with `match: "path"`. The diff is the behavior: which properties change, from what to what, with which transition.
4. For tabbed or cycling content, extract the content of **every** state, not just the default.

Hover and focus styles from `:hover`/`:focus` rules show up only while the pointer is actually there; if `browser_action` hover does not trigger a rule, read the rule from `document.styleSheets` instead. `(hover: none)` and `(pointer: coarse)` media are not emulated at mobile widths — read those rules from the stylesheets too.

Record everything in `BEHAVIORS.md`: per section, the interaction model and each behavior's trigger (exact scroll offset or intersection threshold, click target, hover target), state A, state B and transition.

**Responsive sweep.** Repeat the topology extraction at 768×900 and 390×844 (`browser_viewport`; the size holds until changed). Note which sections change layout and the breakpoint at which they do — read the site's actual media query breakpoints from its stylesheets rather than guessing.

## 2. Foundation

Sequential, done by the lead, because it touches shared files. Re-read the output plan first.

1. Fonts via `next/font/google` or `next/font/local` in `src/app/layout.tsx` (or a route layout when not app-global).
2. Tokens, keyframes and global behaviors merged into `src/app/globals.css` without removing what existing routes need; page-specific pieces scoped under a route wrapper.
3. Content types in `src/types/`, namespaced per site.
4. SVG icons as React components: same-site shared icons in `src/components/sites/<site-key>/shared/icons.tsx`, page-only icons in the page's component root. Name them by function (`SearchIcon`, `LogoMark`). `browser_extract` includes small inline SVG markup verbatim.
5. The downloader script: Node, 4 downloads at a time, the source page as `Referer`, error handling that reports failures without aborting the batch, output into the asset root. Run it and list what failed; an asset that cannot be fetched becomes an explicitly marked placeholder.
6. `npm run typecheck`. The foundation is done when it passes.

## 3. Component specifications

For each section, top to bottom:

1. `browser_extract` the section (`maxDepth` 10 is usually enough; a cut subtree is reported in `omitted` — extract it as its own target) at 1440, 768 and 390, saved under `extract/`.
2. Judge complexity. A distinct sub-component has its own styling, structure and behavior (a card variant, a nav item, a search panel). One or two: one spec. Three or more: one spec per sub-component plus one for the wrapper that composes them.
3. Write `components/<ComponentName>.spec.md`:

```markdown
# <ComponentName>

- Target file: src/components/sites/<site-key>/<page-key>/<ComponentName>.tsx
- Root: <element>, with data-section="<section-name>" on the root element
- Interaction model: static | click-driven | scroll-driven | hover-driven | time-driven

## Structure
<the element hierarchy — what contains what>

## Styles (computed values, exact)
### <element>
- <property>: <value>

## States and behaviors
### <behavior>
- Trigger: <exact: scroll offset 80px / IntersectionObserver rootMargin "-30% 0px" / click on tab / hover>
- State A: <properties>
- State B: <properties>
- Transition: <property duration easing delay>
- Implementation: <CSS transition + scroll listener | IntersectionObserver | CSS animation | …>

## Content (verbatim, per state)

## Assets
- <public/sites/... path> — <role; layer order when stacked>
- Icons: <names> from <module>

## Responsive
- 1440: … / 768: … / 390: … — breakpoint at <N>px (from the stylesheet)
```

Every value comes from an extraction, never from estimation. Fill every section; write `N/A` only after checking — even a footer has link hover states. The `data-section` attribute on each section root is what QA targets on the clone.

**Budget:** a spec over ~150 lines, or over 16,000 characters, is too big for one builder. Split it.

**Before dispatching any builder, all must hold:**

- [ ] The spec file exists with every section filled.
- [ ] Every value is from an extraction.
- [ ] The interaction model is identified — scroll tested before click.
- [ ] Every state's content and styles are captured; scroll behaviors have threshold, before/after and transition; hover behaviors have before/after and timing.
- [ ] Every image in the section is listed, including overlays and stacked layers.
- [ ] Responsive behavior is recorded for at least desktop and mobile.
- [ ] Text is verbatim.
- [ ] The spec is within budget.

## 4. Dispatch

Builders are NekoCode `task` workers. The `task` tool exists only in the **delegate** phase: once the foundation typechecks, request it with `switch_mode` and say why. If the user declines, build the sections yourself from the same specs — the specs, checks and QA do not change.

One `task` per spec:

- `kind: "worker"`.
- `designSpec`: the **complete** spec file, inline. Workers do not read other files for requirements; never write "see the spec" or "see DESIGN_TOKENS.md".
- `prompt`: the target file path; exactly which shared modules to import (`cn` from `@/lib/utils`, the icon module, shadcn primitives); the asset paths; "Write only the declared file(s). Do not touch routes, globals, layouts, shared icons, package files or research artifacts. Report anything in the spec you could not implement."
- `writablePaths`: exactly the component file(s) of this spec.

Limits: outside Fusion, at most 4 workers run at once and they have no shell. In Fusion one Sidekick runs at a time. Either way the **lead** verifies: after each batch completes, run `npm run typecheck` and fix integration errors before dispatching more.

**Do not wait idle.** After dispatching a section's builders, go on extracting the next section; a finished worker resumes you automatically. Do not poll `task_status`. Before leaving the delegate phase, make sure no worker is still running.

## 5. Assembly

Wire the page at its planned route: import the sections, implement page-level layout from `PAGE_TOPOLOGY.md` (scroll containers, columns, sticky layers, z-order), connect content, and implement page-level behaviors (snap, scroll-driven animation, section theme changes, smooth scroll). Confirm every route that existed before the run is still present and unchanged. Run `npm run check`.

## 6. QA

1. `website_clone_dev_server` `start` on the app root. Use the URL it returns plus the route — never a guessed port. If the page fails to compile, `status` shows the error.
2. For each viewport (1440×900, 768×900, 390×844):
   - Source: `browser_navigate`, `browser_viewport`, `browser_extract` with one target per section (`name` = section name, `selector` = the source selector from `PAGE_TOPOLOGY.md`) → `qa/source-<width>.json`.
   - Clone: the same, with the **same names** and `[data-section="<name>"]` selectors → `qa/clone-<width>.json`.
   - `website_clone_compare` (`match: "text"`) → `qa/diff-<width>.md`.
3. For each issue: check the spec against the extraction. Spec wrong → re-extract, fix the spec, fix the component. Spec right → fix the component. `browser_navigate` to the clone URL again to load the rebuilt page, re-extract, re-compare. Repeat until the only remaining differences are ones you can explain (for example, font rasterization within a pixel, an asset that could not be downloaded).
4. Behaviors: for each entry in `BEHAVIORS.md`, run the same before/after `match: "path"` comparison on the clone and check it changes the same properties to the same values with the same transition.
5. Screenshots are a second check, not the gate. Take one `browser_screenshot` of the source at 1440; if its result says the image is attached, compare viewport screenshots of source and clone section by section at 1440 and 390 as well. If it says images are not attached, the structural comparison is the whole of QA.
6. `website_clone_dev_server` `stop` when done.

## Common failures

- Building click tabs for a scroll-driven section, or the reverse — the most expensive mistake; it means a rewrite. Scroll before clicking.
- Extracting only the default state of tabs, headers, menus.
- Missing a layered image: a background plus a foreground mockup is two assets.
- Rebuilding in HTML what is really a `<video>`, Lottie or `<canvas>`.
- Rounding to a Tailwind preset: `text-lg` is 18px/28px; if the computed line-height is 24px, write `leading-[24px]`.
- One builder for unrelated sections, or a builder given a whole complex section.
- Skipping responsive extraction, or smooth-scroll libraries.
- Replacing an existing route or another page's namespace.

## Completion report

- Source URL → route, for every page; `<app-root>`.
- Existing routes preserved, and any approved replacements.
- Sections, components and spec files created (specs should equal components); assets downloaded and assets that failed.
- Commands actually run, and the result of the final `npm run check`.
- QA: viewports compared, issues remaining per viewport, behaviors verified, and whether screenshot QA ran.
- Known gaps.
