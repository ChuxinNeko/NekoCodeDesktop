"""Generate app icons from resources/icons/source.png (requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "resources" / "icons"
PUBLIC = ROOT / "src" / "renderer" / "public"
SIZE = 1024
RADIUS = 0.22


def main():
    source = Image.open(ICONS / "source.png").convert("RGBA")
    if source.width != source.height:
        raise ValueError("The source icon must be square to avoid cropping the artwork")
    icon = source.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    # Supersample just the mask, preserving the original artwork and white tile.
    scale = 4
    mask = Image.new("L", (SIZE * scale, SIZE * scale))
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, SIZE * scale - 1, SIZE * scale - 1),
        radius=round(SIZE * scale * RADIUS),
        fill=255,
    )
    mask = mask.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    icon.putalpha(ImageChops.multiply(icon.getchannel("A"), mask))
    icon.save(ICONS / "icon.png", optimize=True)
    sizes = [(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)]
    frames = []
    for size in sizes:
        frame = icon.resize(size, Image.Resampling.LANCZOS)
        # Remove barely-visible ringing outside the shape at small icon sizes.
        frame.putalpha(frame.getchannel("A").point(lambda alpha: 0 if alpha < 4 else alpha))
        frames.append(frame)
    icon.save(ICONS / "icon.ico", sizes=sizes, append_images=frames)
    icon.save(ICONS / "icon.icns")
    PUBLIC.mkdir(parents=True, exist_ok=True)
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(PUBLIC / "icon.png", optimize=True)
    print("Generated rounded PNG, Windows ICO, macOS ICNS and renderer icon")


if __name__ == "__main__":
    main()
