# Application icons

- `source.png`: original artwork moved from the supplied Downloads file.
- `icon.png`: 1024 × 1024 PNG with antialiased, transparent rounded corners (22% radius).
- `icon.ico`: Windows icon with 16, 20, 24, 32, 40, 48, 64, 128 and 256 px variants.
- `icon.icns`: macOS packaging asset.
- `../../src/renderer/public/icon.png`: 256 px renderer/favicon variant.

To regenerate after changing the source, run `python scripts/generate-app-icons.py`
from the project root with Pillow installed. The generator preserves the artwork
and white background, applying transparency only around the rounded corners.

Electron Vite bundles native icon paths through `?asset` imports. Windows/Linux
windows and the macOS Dock use these icons; the title bar, About page and favicon
use the renderer variant. When adding installer packaging, use `icon.ico` for the
Windows executable and `icon.icns` for the macOS application bundle.
