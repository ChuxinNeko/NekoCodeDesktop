# Beautiful UI Agent Screen integration

Sources checked on 2026-10-17:

- AgentScreen: the `components/AgentScreen.tsx` source supplied by the user from https://www.beautifului.dev/#agent-screen. The advertised https://www.beautifului.dev/r/agent-screen.json endpoint returned HTTP 404, so this was integrated manually.
- Button: https://www.beautifului.dev/r/button.json. `Button.tsx` preserves its variants, sizes and behavior; only the import path and semantic utility names have changed.
- Foundation: https://www.beautifului.dev/r/foundation.json. `foundation.css` copies its light/dark tokens, theme mappings and relevant primitives/keyframes. The light shadow stacks come from the site's compiled CSS (shadow-plugin/unprefixed values). All tokens/utilities are namespaced `bui` to avoid changing the application's theme. Page backgrounds and unrelated component CSS are omitted.

`../dock/AgentScreen.tsx` adapts the supplied layout for live SSH canvas and MCP webview content. It retains the 340px card, accent Open pill, caption, 44px header, 16px overlay corners, 8px inset corners, 960px/90vw media limit, shadows and animation timings. The media aspect ratio follows the actual SSH desktop when available.

The demo's image and local recording timer are replaced with the existing live desktop and working takeover/reconnect actions. A native modal dialog replaces the conditional portal so the same canvas/webview stays connected while expanding. Escape, backdrop dismissal, focus/scroll restoration and input release are maintained. The viewer uses the application's font stack and translated labels.


## Selection Actions

Installed with `npx shadcn@latest add https://www.beautifului.dev/r/selection-actions.json`
on 2026-10-18, including its declared `iconoir-react` dependency. The CLI's
explicit targets resolved to `src/components` in this Electron project; the
installed files were moved into the renderer:

- `../primitives/SelectionActions.tsx`
- `Shimmer.tsx` and `StreamText.tsx`

The installed duplicate Button and foundation were removed in favor of this
folder's existing Button and `bui` tokens. Only the needed official shimmer and
streaming CSS was added, scoped to `.beautiful-selection-actions`.
`components.json` directs CSS writes to an unused staging stylesheet, protecting
`src/renderer/src/index.css`; do not import that staging stylesheet.

The official bar layout, icons, expansion, width animation and inner pop-in timing
are retained. The position layer measures synchronously before paint and stays
hidden until measured. It uses viewport `left`/`top` with opacity-only entry,
anchored below the last selected line near mouse release. Resize/scroll remeasure
the current selection; viewport edges clamp placement (or flip above at the bottom).
There is no position transition from a default origin. Gallery passage constants and the automatic reveal/stream timers
are removed. A captured DOM Range supplies the anchor; translated rewrite actions invoke
the existing session sender; Explain opens the isolated chat described below. A successful send ends local thinking; formal output
appears in the next chat reply. Optional preview accepts only caller-supplied model
text; Keep and Discard reset local UI and never edit persisted cells.
`chat/AssistantSelection.tsx` owns selection scope, dismissal, portal and clipboard.


## Explanation chat

Installed with `npx shadcn@latest add https://www.beautifului.dev/r/chat-composer.json`
on 2026-10-18. The registry declares only foundation; no component dependencies
were added. As with Selection Actions, the CLI wrote its explicit target under
`src/components`; its installed ChatComposer was moved to
`../primitives/ChatComposer.tsx`, and its duplicate foundation was removed.

ChatComposer retains the official card/header, reply Section, user bubble and
composer structure, SVGs, tab selection and Enter/send behavior. Semantic classes
and inline variables use existing `bui` tokens. Gallery constants and scripted
phase timers are removed; `messages` now renders every supplied user/assistant
turn, pending follows request state, and `labels` supplies translated accessibility
text. Decorative gallery header actions are disabled. No second chat/composer is
implemented.

Explain opens `chat/SelectionExplanation.tsx` beside the selected passage with
only the chat card visible. Assistant replies use the shared Markdown renderer.
Initial explanation and follow-ups use `selection:explain`
through preload and `SelectionExplanationService`, which calls the existing model
runtime directly via `askModel`. It never calls the main session sender or stores
cells. Each request reads the selected main session's current model context,
including instructions, workspace, messages and tool results; image payloads and
private reasoning blocks are omitted. Popup history exists only in renderer memory and is sent as context for
subsequent side-chat requests. Closing cancels the in-flight request and discards
this history. All other Selection Actions keep their existing `onSend`/copy paths.
