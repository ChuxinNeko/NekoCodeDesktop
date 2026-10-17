# PI kernel provenance

The vendored runtime is PI **1.3.0**, including changes through upstream commit
`8efd314fa3d3232ce197d8d7a6a5660530b9d83e` (2026-10-17 Asia/Taipei).
Source: the supplied `demo/pi` checkout of `https://github.com/earendil-works/pi`.

The upgrade used a three-way merge, not a directory replacement:

- Upstream base: `a276dabe57911253350bffb93cb7d7aff6a73261` (1.0.0 plus subsequent fixes).
- NekoCode baseline: `069de6bfc65c8f6788a195aa8bf03ebef9bae8b7`.
- Incoming upstream: `8efd314fa3d3232ce197d8d7a6a5660530b9d83e`.

`upstream.json` records every pre-upgrade customized file and every local-only
file, rather than relying on the most recent NekoCode commit to identify patches.

## Retained NekoCode behavior

- `.nekocode` branding, with existing project `.pi` settings, packages, extensions,
  prompts, skills, themes, trust and MCP configuration remaining discoverable.
- SDK `toolOptions`, dynamic `setCustomTools()` and permission-owned tool loadouts;
  changes to a running role continue into subsequent requests.
- App-specific compaction instructions in both complete and split-turn summaries,
  awaited `afterCompaction` callbacks and separate callback error reporting.
- Tool usage guidelines under custom system prompts and public image processing exports.
- NekoCode request identity, caller-overridable Codex identity headers, OAuth login
  account selection and refresh scope, and readable transport cause chains.
- Long-work recovery's explicit `retry` decision, cancellation boundary, discarded
  truncated tool arguments and cleared error state after a successful continuation.
- Kimi catalog key fallbacks, local prompt library and fork regression tests.
- Workspace-specific package metadata and disabled upstream npm publishing hooks.

## Conflict resolutions and integration changes

- Kept NekoCode Codex header defaults while retaining upstream's equivalent caller
  header precedence. Authorization and account headers remain credential-derived.
- Combined Kimi's regional/historical catalog key fallback with upstream's new
  `createKimiCodingModels()` Chat Completions implementation.
- Kept `preserveLoadout` while adopting upstream's wildcard tool-name matcher.
- OpenCode Go's Google Generative AI support is now supplied upstream; kept that
  implementation and the updated inference endpoints.
- Combined new schema/benchmark scripts with the existing disabled publishing hooks.
- Removed upstream's obsolete experimental client/protocol/server stack. Its only
  local differences were publishing metadata, not runtime functionality; the app
  did not import those packages. Added the new `pi-env` package and build step.
- Pinned app workspace dependencies to 1.3.0, refreshed `bun.lock`, synchronized the
  provider default-model table and made PI builds refresh stale generated model data.
- Kept application tests scoped to `./test`, so Bun does not also collect unrelated
  upstream release-tool tests by interpreting `test` as a name filter.
- Migrated the fork's agent-loop test stream to upstream's measured stream factory.
  Migrated the local Codex header test to normalized transcript context and allowed
  undefined header values in the upstream Responses test fixture.
- Added the shared upstream Vitest config, supporting script dependencies and a
  private ESM package marker for PI's root-level TypeScript tooling. The root
  development dependencies include upstream's pinned sandbox runtime so its
  independently packaged sandbox example can also be typechecked.

## Verification

- `bun run pi:build`, `bun run build`, `bun run typecheck` and
  `bun x --no-install tsc --noEmit -p pi/tsconfig.json` all pass.
- 416 targeted PI tests: agent loop/state, compaction callbacks, system prompts,
  SDK options, resource loading, trust, templates, retry, OAuth/headers and transport errors.
  On Windows, coding-agent tests use an isolated `TEMP`/`TMP` below `.tools` so the
  real user's ancestor `.agents/skills` cannot affect synthetic trust fixtures.
- Application suite: 1386 passing tests and 5 pre-existing renderer failures.
  The same 5 failures were reproduced from the unmodified NekoCode baseline snapshot:
  two ACP timeline `window.matchMedia` fixture failures, one Fusion cost-display
  expectation and two planning-state rendering expectations.
- An additional project-config compatibility test confirms `.pi` fallback and
  `.nekocode` precedence; it and the long-work/helper regression suites pass.

For the next upgrade, use the incoming upstream commit above as the merge base,
compare **all** changes under `pi/` to that commit, retain local-only files, and
review upstream deletions and overlapping API changes before applying them.
