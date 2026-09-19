---
name: design
description: Create polished design artifacts inside the current NekoCode workspace using a curated, filesystem-first OpenDesign workflow. Use for landing pages, web prototypes, dashboards, mobile screens, HTML slide decks, posters, visual assets, and motion studies. Invoke directly with /design [brief].
---

# Design

Build the design requested in the user brief that follows this skill block inside the current NekoCode workspace. This is NekoCode's curated in-chat adaptation of OpenDesign: use the current model, filesystem tools, and browser preview rather than launching a separate OpenDesign daemon or desktop app.

## Discovery

If no user brief follows the skill block, ask what the user wants to design before writing files. If a brief exists, infer safe defaults and ask at most three focused questions only when the artifact type, essential content, or destination is genuinely ambiguous. Do not ask the user to choose implementation details that can be derived from the repository.

Before editing, inspect the repository's framework, conventions, dependencies, existing routes, design tokens, `DESIGN.md`, and likely destination files. Preserve existing work. If the requested destination already exists and replacement was not explicit, ask before replacing it.

## Choose one route

Read `references/open-design/frontend-design/SKILL.md` for every route, then read the matching route completely, including the side files it names:

- General website, landing page, marketing page, or desktop prototype: `references/open-design/templates/web-prototype/SKILL.md`
- Admin, analytics, operations, or data dashboard: `references/open-design/templates/dashboard/SKILL.md`
- iOS, Android, phone screen, or mobile app mockup: `references/open-design/templates/mobile-app/SKILL.md`
- Presentation, pitch, report, or slides: `references/open-design/templates/simple-deck/SKILL.md`
- A vague brief that needs concrete tokens: `references/open-design/design-brief/SKILL.md`
- Poster, cover, or static visual: use the frontend craft rules to create an editable SVG or a self-contained HTML poster. Do not claim to have generated PNG/JPEG pixels unless an available tool actually did so.
- Video, reel, animation, or motion study: create a self-contained animated HTML/CSS/JS artifact that the NekoCode browser can preview. Do not claim MP4 export unless an available renderer actually produced the file.

The OpenDesign references describe their native project root. Resolve every path against the user's chosen destination in this workspace, not against this skill directory. Treat OpenDesign-only host features such as injected design systems, `data-od-id` comment mode, `<artifact>` wrappers, `OD_BIN`, media dispatch, and daemon metadata as optional context, not available NekoCode tools.

## Design contract

1. Lock one specific visual direction before implementation. Use the user's brand or existing `DESIGN.md` when present; otherwise define a compact local token set covering color, typography, spacing, layout, component shape, states, and motion.
2. Build real usable content, not lorem ipsum or empty decorative shells. Label invented metrics and examples honestly.
3. Follow the existing framework and component system when integrating into an application. For a standalone artifact, prefer one self-contained HTML file with inline CSS/JS and no new dependency.
4. Use semantic markup, responsive layouts, keyboard-accessible controls, visible focus states, sufficient contrast, and reduced-motion handling.
5. Avoid generic AI styling: interchangeable SaaS cards, gratuitous purple gradients, excessive glass effects, uniform pill shapes, decorative blobs, and animation without purpose.
6. Include the states needed by the artifact: hover, focus, active, disabled, loading, empty, and error where applicable.
7. Keep source files editable. Never replace editable output with a screenshot.

## Output placement and preview

Honor an explicit target path. When adding to an existing application, integrate into its established route/component structure. For a standalone artifact with no requested location, write directly in the workspace root, normally as `index.html`, and keep any local assets in root-relative asset paths. If that destination already exists, ask before replacing it. Do not overwrite a root `DESIGN.md`; reuse it when present, or place artifact-specific design notes beside the output.

After writing a standalone HTML file, let NekoCode's browser preview open it. For an application route, run the narrowest available validation and start its existing development server only when runtime verification is needed. Never guess a server URL or claim visual verification that was not performed.

## Review and delivery

Before finishing, check desktop and mobile behavior, text overflow, hierarchy, interaction states, keyboard use, contrast, and reduced motion. Run the repository's relevant typecheck/build when available. Report:

- artifact type and visual direction
- files created or changed
- preview or validation actually performed
- any export limitation or remaining discrepancy

PNG/JPEG model generation and MP4/PPTX/PDF export are not bundled with this curated integration. Offer the editable SVG/HTML/deck source instead unless a compatible installed tool is actually available.

## Attribution

Adapted from OpenDesign 0.22.2 by nexu-io under Apache-2.0. The selected upstream references are bundled under `references/open-design/`; see the repository's `licenses/OpenDesign-LICENSE.txt` and third-party notices.
