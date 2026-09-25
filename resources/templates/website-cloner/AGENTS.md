<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Website Clone Project

A Next.js project that NekoCode's `/clone-website` skill fills with high-fidelity clones of target pages. The Next.js + shadcn/ui + Tailwind v4 base is pre-scaffolded. The cloning process itself is defined by the skill (its `SKILL.md` and `references/workflow.md`, shipped with NekoCode), not by this file; this file covers the project.

## Tech Stack
- **Framework:** Next.js 16 (App Router, React 19, TypeScript strict)
- **UI:** shadcn/ui primitives, Tailwind CSS v4, `cn()` from `@/lib/utils`
- **Icons:** extracted SVGs as React components; Lucide React only where the source uses it
- **Runtime:** Node.js ≥ 20.9.0, or Bun

## Commands

Use one package manager for the whole project — the one whose lockfile is present.

| Task | npm | Bun |
|---|---|---|
| Install | `npm install` | `bun install` |
| Dev server | `npm run dev -- --port <port>` | `bun --bun run dev -- --port <port>` |
| Lint / types / build | `npm run lint` / `npm run typecheck` / `npm run build` | `bun --bun run lint` / `… typecheck` / `… build` |
| Everything | `npm run check` | `bun --bun run check` |

With Bun always pass `--bun`: otherwise the scripts run on whatever `node` is on PATH, and an old one fails the Node version check. Never call `next`, `npx next`, or `bunx next` directly; the scripts set the environment the build needs.

Inside NekoCode, start and stop the dev server with the `website_clone_dev_server` tool, not a shell command: a shell command waits for the server to exit, which it never does.

## Project Structure
```
src/
  app/                                  # Routes; each clone at its source pathname
  components/
    ui/                                 # shadcn/ui primitives
    sites/<site-key>/shared/            # Components and icons shared within one site
    sites/<site-key>/<page-key>/        # One cloned page's components
  lib/utils.ts                          # cn()
  types/                                # Content types
  hooks/                                # Custom hooks
public/
  sites/<site-key>/shared/              # Assets shared within one site
  sites/<site-key>/<page-key>/          # One page's images, videos, fonts, icons
docs/
  research/<site-key>/<page-key>/       # Extraction data, component specs, QA reports
scripts/
  download-assets-<site-key>-<page-key>.mjs
```

Never write one page's files into another page's namespace, and never replace an existing route without explicit approval.

Each cloned section's root element carries `data-section="<section-name>"`, the name its spec and the QA extractions use. Keep it when editing a section.

## Code Style
- TypeScript strict, no `any`; named exports; PascalCase components, camelCase utilities; 2-space indentation.
- Tailwind utilities first. When a preset does not equal the extracted value, use an arbitrary value (`leading-[24px]`, `text-[#1a1a1a]`, `shadow-[0_4px_20px_rgba(0,0,0,0.1)]`) rather than the nearest preset. Use a `style` prop only for values Tailwind cannot express (for example computed or animated custom properties).
- Mobile-first responsive classes, with breakpoints taken from the source site.

## Fidelity
- Match the source exactly: spacing, color, typography, behavior, and every interactive state. No aesthetic changes during cloning.
- Real content and the site's own assets, never placeholders — except an explicitly marked placeholder for an asset that could not be downloaded.
