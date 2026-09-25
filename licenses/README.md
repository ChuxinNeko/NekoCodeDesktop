# Third-party notices

This project contains code derived from upstream projects licensed under MIT and
Apache-2.0, and bundles unmodified MPL-2.0 runtime components. The full license
texts are in this directory.

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

## Taste Skill — frontend craft layer (`resources/skills/design/references/taste-skill/`)

MIT — see [TasteSkill-LICENSE.txt](./TasteSkill-LICENSE.txt).

Upstream: <https://github.com/Leonxlnx/taste-skill>, pinned to commit
`4843a7fdb4fb7320d4e3c021df72ee393d1dcf3e`. The default
`design-taste-frontend` v2 experimental `SKILL.md` is bundled verbatim as a
contextual craft and pre-flight reference behind NekoCode's existing `/design`
skill. The NekoCode wrapper selects applicable routes and reconciles upstream
framework, dependency, image-generation, and block-library assumptions with the
current workspace and available native tools; no separate Taste Skill command or
plugin metadata is bundled.

## ai-website-cloner-template — the built-in clone skill and scaffold (`resources/skills/clone-website/`, `resources/templates/website-cloner/`)

MIT — see [WebsiteCloner-LICENSE.txt](./WebsiteCloner-LICENSE.txt).

Upstream: `JCodesMore/ai-website-cloner-template` 0.5.0. Both pieces sit behind
the built-in `clone-website` skill invoked with `/clone-website`:

- `resources/skills/clone-website/` — `SKILL.md` and `references/workflow.md`
  are NekoCode's rewrite of the upstream clone skill and inspection guide. The
  procedure (output isolation, interaction sweep, component specifications,
  foreman-style parallel builders, QA) is derived from upstream; its platform
  assumptions — Browser MCP, Git worktrees, builders on separate branches,
  screenshot-based QA — are replaced by NekoCode's native browser tools, fixed
  structural extractor and comparison, managed dev server, and shared-workspace
  `task` workers.
- `resources/templates/website-cloner/` — the upstream Next.js scaffold, with
  its agent notes (`AGENTS.md`), package metadata, scripts and ignore rules
  adapted to NekoCode.

## Cua Driver — Computer Use on Windows (`src/main/computer/`)

MIT, Copyright (c) 2025 Cua AI, Inc. — see [Cua-LICENSE.txt](./Cua-LICENSE.txt).

Upstream: <https://github.com/trycua/cua>, npm `@trycua/cua-driver` pinned to 0.28.2
with its prebuilt native package `@trycua/cua-driver-win32-*-msvc`. Used unmodified as
a dependency: the driver library is loaded in a utility process and wrapped by
NekoCode's own tool layer; no upstream source is copied into this repository.

The SDK's Node runtime — `@ubjs/core`, `@ubjs/node`, `@ubjs/node-win32-*-msvc`, and
`cua_driver_node_runtime.node` inside the Cua native package — is derived from
`uniffi-bindgen-react-native` and licensed under the Mozilla Public License 2.0
(<https://www.mozilla.org/MPL/2.0/>). These files are shipped unmodified in
`app.asar.unpacked/node_modules/`; their source is available from
<https://github.com/jhugman/uniffi-bindgen-react-native> and the Cua repository at
the matching release tag, as the package's `node-runtime-NOTICE.md` states.

## Agent Client Protocol adapters — external agents (`src/main/acp/`)

The built-in Codex and Claude Agent workspaces run ACP adapters that ship with
NekoCode as npm dependencies, unmodified, in `app.asar.unpacked/node_modules/`.
They run on NekoCode's own Electron runtime and drive the CLI the user installed;
the agents themselves are **not** bundled.

- `@agentclientprotocol/codex-acp` 1.13.1 — Apache-2.0, Copyright 2025 JetBrains
  s.r.o. — see [codex-acp-LICENSE.txt](./codex-acp-LICENSE.txt).
  Upstream: <https://github.com/agentclientprotocol/codex-acp>.
- `@agentclientprotocol/claude-agent-acp` 0.81.1 — Apache-2.0, Copyright 2025 Zed
  Industries, Inc. and contributors — see
  [claude-agent-acp-LICENSE.txt](./claude-agent-acp-LICENSE.txt).
  Upstream: <https://github.com/agentclientprotocol/claude-agent-acp>.
- `@agentclientprotocol/sdk` — Apache-2.0 — see [acp-sdk-LICENSE.txt](./acp-sdk-LICENSE.txt),
  loaded by the Claude adapter.
- `@anthropic-ai/claude-agent-sdk` (JavaScript only) — © Anthropic PBC, use subject to
  <https://code.claude.com/docs/en/legal-and-compliance> — see
  [claude-agent-sdk-LICENSE.md](./claude-agent-sdk-LICENSE.md). Loaded by the Claude
  adapter. Its platform packages containing the Claude Code binary
  (`@anthropic-ai/claude-agent-sdk-*`) are excluded from the package; the adapter uses
  the user's own Claude Code installation instead.
- `zod` — MIT, loaded by the Claude adapter.

The Codex CLI package the Codex adapter declares (`@openai/codex` and its
`@openai/codex-*` platform packages, ~440 MB) is likewise excluded; the adapter is
pointed at the user's own Codex installation through `CODEX_PATH`.
