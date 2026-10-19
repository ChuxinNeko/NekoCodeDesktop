# Wallpaper theme and readability

The wallpaper settings include **Follow wallpaper theme** (off by default).
It picks an in-memory light/dark variant, not a new saved theme preference:

1. Prefer Wallpaper Engine's declared scheme colour. An all-black author
   default means "unfilled", so sample instead.
2. Otherwise sample a preview/upload at 64×64. Quantize RGB into 4-bit buckets
   and use the most frequent nontransparent bucket, not average colour.
3. For video and capturable live scenes, also take one actual frame. A conflict
   between preview and frame favours dark. Web projects without a capturable
   canvas fall back to the poster; unavailable or cross-origin pixels leave
   the original theme unchanged.
4. WCAG relative luminance > 0.40 selects light, otherwise dark.

Manual theme choices take precedence for the current wallpaper, including
choices made before the asynchronous sample finishes. Selecting another
wallpaper or switching follow off/on starts a new evaluation. Turning off the
wallpaper (including strength zero) releases the transient layer and restores
the saved light/dark/system preference. Sampling is bounded and cancelled on
wallpaper changes; it is not a continuously flipping per-frame theme.

## Contrast protection

While a wallpaper is displayed, all window reading surfaces share a theme-base
glass floor: 0.45 light / 0.59 dark. The effective tint opacity is
`floor + originalOpacity * (1 - floor)`; the original glass and panel opacity
values are 0.55 / 0.275. The colour is clamped toward the appropriate theme
extreme when needed. Primary, secondary and tertiary text colours are adjusted
against the least opaque protected panel over the worst-case black/white
wallpaper, with a 4.6:1 minimum calculation target to allow 8-bit rounding.
The rule does not promise the same contrast for intentionally faded/disabled
controls, custom document text, syntax/ANSI colours or embedded web pages.

The navigation receives **no blur and no new per-button glass fill**.
Only the underlying shared window surface and semantic text colours adapt.
Inverse accent-button text and semantic danger colours retain their existing
roles. Native select options have an opaque paired background and text colour.
Removing the wallpaper restores the original CSS variables.

## Verification

- `bun test test/renderer/lib/wallpaperAppearance.test.ts`
- `bun run typecheck`
- `bun run build`
- Visually inspect dark/light uploads, mismatched manual themes, settings
  controls, menus/dialogs, navigation, and wallpaper-off restoration.

## Attribution

Adapted from the theme-follow and readability-floor techniques in
[elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)
at `01fbb8b8e66fd7e405e9c878d18dbd456187f111`, under the MIT license:

MIT License

Copyright (c) 2026 elysia395

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.