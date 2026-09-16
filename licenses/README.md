# Third-party notices

This project contains code derived from two MIT-licensed upstream projects. The
full license texts are in this directory.

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
