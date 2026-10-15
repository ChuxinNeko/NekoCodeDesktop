#!/usr/bin/env python3
"""用桌面端同款图标（../resources/icons）生成移动端图标。

用法（在 mobile_flutter 目录）: python3 scripts/generate-app-icons.py
依赖 Pillow。产物：Android 传统/自适应/单色图标、iOS AppIcon、应用内 Logo。
"""
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT.parent / 'resources' / 'icons'
SOURCE = Image.open(ICONS / 'source.png').convert('RGB')  # 白底原稿
RES = ROOT / 'android/app/src/main/res'
APPICON = ROOT / 'ios/Runner/Assets.xcassets/AppIcon.appiconset'


def resize(img, size):
    return img.resize((size, size), Image.LANCZOS)


def rounded(img, radius_ratio=.22):
    """与桌面端 icon.png 一致：白底 + 22% 圆角透明。"""
    n = img.width * 4
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, n - 1, n - 1), radius=int(n * radius_ratio), fill=255
    )
    mask = mask.resize(img.size, Image.LANCZOS)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


# --- Android 传统图标 ---
for folder, size in {
    'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192,
}.items():
    rounded(resize(SOURCE, size)).save(RES / f'mipmap-{folder}' / 'ic_launcher.png')

# --- Android 自适应图标：108dp 画布，主体缩到安全区内 ---
def layer(px, scale):
    canvas = Image.new('RGB', (px, px), 'white')
    art = resize(SOURCE, int(px * scale))
    canvas.paste(art, ((px - art.width) // 2, (px - art.height) // 2))
    return canvas

for folder, px in {
    'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432,
}.items():
    layer(px, .74).save(RES / f'mipmap-{folder}' / 'ic_launcher_foreground.png')
    # 单色（Android 13 主题图标）：深色部分作为 alpha，白色眼睛/留白镂空
    gray = layer(px, .74).convert('L')
    alpha = gray.point(lambda v: 0 if v > 200 else min(255, (200 - v) * 3))
    mono = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    mono.putalpha(alpha)
    mono.save(RES / f'mipmap-{folder}' / 'ic_launcher_monochrome.png')

(RES / 'mipmap-anydpi-v26').mkdir(exist_ok=True)
(RES / 'mipmap-anydpi-v26' / 'ic_launcher.xml').write_text(
    '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
'''
)
(RES / 'values' / 'ic_launcher_background.xml').write_text(
    '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFFFFF</color>
</resources>
'''
)

# --- iOS：不含透明通道，系统自行裁圆角 ---
contents = json.loads((APPICON / 'Contents.json').read_text())
for item in contents['images']:
    base = float(item['size'].split('x')[0])
    px = round(base * int(item['scale'].rstrip('x')))
    resize(SOURCE, px).save(APPICON / item['filename'])

# --- 应用内 Logo ---
out = ROOT / 'assets/images'
out.mkdir(parents=True, exist_ok=True)
rounded(resize(SOURCE, 512)).save(out / 'logo.png', optimize=True)
print('done')
