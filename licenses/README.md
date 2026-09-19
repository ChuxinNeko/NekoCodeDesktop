# Third-party notices

This project contains code derived from upstream projects licensed under MIT and
Apache-2.0. The full license texts are in this directory.

## pi — the agent core (`pi/`)

Copyright (c) 2025 Mario Zechner — see [pi-LICENSE.txt](./pi-LICENSE.txt).

`pi/` is the pi agent harness source (upstream: <https://github.com/earendil-works/pi>),
vendored into this repository as first-party source so it can be modified in place.
Upstream package names (`@earendil-works/*`) and the license text are kept as-is for
attribution. Changes made here:

- The upstream monorepo manifest (`package.json` with its `workspaces` field), CI
  workflows, release/publish scripts, repo docs, and per-package `repository`/`author`
  metadata were removed; the packages are workspace members of this project instead.
- `pi/packages/ai` now declares `@smithy/types` as a dependency. It was imported
  directly by `src/api/bedrock-converse-stream.ts` but only present transitively, so it
  resolved solely via upstream's hoisted `node_modules`.
- The root `package.json` declares `esbuild`, which `pi/scripts/build-coding-agent-bundle.mjs`
  needs but upstream only listed under `packages/chord`.

## Synara — the interface design system (`src/renderer/`)

Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 Emanuele Di Pietro — see
[Synara-LICENSE.txt](./Synara-LICENSE.txt).

Upstream: <https://github.com/Emanuele-web04/synara>. The following files were copied
from Synara's `apps/web/src/` and adapted:

| This project | Upstream |
| --- | --- |
| `src/renderer/src/index.css` | `index.css` |
| `src/renderer/src/theme/theme.logic.ts`, `theme.seed.generated.ts` | `theme/` |
| `src/renderer/src/components/ui/*` | `components/ui/` |
| `src/renderer/src/lib/icons.tsx`, `central-icons.tsx`, `sidebarRowStyles.ts`, `appDensity.ts`, `chatWidth.ts`, `fontFamily.ts` | same names |
| `src/renderer/src/surfaceStyles.ts`, `components/chat/composerPickerStyles.ts` | same names |
| `src/renderer/public/central-icons-*/` | static icon assets (the 8 in use) |

Changes made here: icon paths are relative (the packaged renderer loads over `file://`),
`lib/utils.ts` was reduced to `cn` plus platform helpers, and the browser panel was
reimplemented against Electron `<webview>` rather than Synara's browser runtime.

## OpenDesign — curated design workflow (`resources/skills/design/`)

Apache-2.0 — see [OpenDesign-LICENSE.txt](./OpenDesign-LICENSE.txt).

Upstream: <https://github.com/nexu-io/open-design>, pinned to version 0.22.2
(commit `73953213a6fec2c8092e8e77d229a3074aa828a9`). Only selected
filesystem-first references and templates are copied into
`resources/skills/design/references/open-design/` and adapted for NekoCode's
in-chat `design` skill — the OpenDesign daemon, web and desktop apps, and media
dispatcher are not bundled. The bundled `frontend-design` reference is itself
adapted from an upstream source and retains its own
`resources/skills/design/references/open-design/frontend-design/LICENSE.txt`.

## ai-website-cloner-template — the built-in clone skill and scaffold (`resources/skills/clone-website/`, `resources/templates/website-cloner/`)

MIT — see [WebsiteCloner-LICENSE.txt](./WebsiteCloner-LICENSE.txt).

Upstream: `JCodesMore/ai-website-cloner-template` 0.5.0. The upstream skill
workflow is bundled verbatim at `resources/skills/clone-website/references/` and
the Next.js scaffold is bundled at `resources/templates/website-cloner/`, both
behind the built-in `clone-website` skill invoked with `/clone-website`. The
platform assumptions — Browser MCP, Git worktrees, and parallel builders on
separate branches — were adapted to NekoCode's native visible browser tools and
shared-workspace workers; the upstream documents themselves are unchanged.
