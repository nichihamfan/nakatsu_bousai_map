"""PWAアイコン生成（シンプルな警戒三角形モチーフ、ブランドカラー使用）"""
from PIL import Image, ImageDraw
import math

PRIMARY = (27, 75, 102, 255)   # #1b4b66
ACCENT = (226, 137, 47, 255)   # #e2892f
WHITE = (255, 255, 255, 255)


def make_icon(size, out_path, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(size * 0.06) if maskable else 0
    # background rounded square
    radius = int(size * (0.22 if not maskable else 0.0))
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=PRIMARY)

    # triangle (warning symbol)
    cx, cy = size / 2, size / 2 + size * 0.03
    tri_h = size * 0.42
    tri_w = size * 0.48
    top = (cx, cy - tri_h / 2)
    left = (cx - tri_w / 2, cy + tri_h / 2)
    right = (cx + tri_w / 2, cy + tri_h / 2)
    d.polygon([top, left, right], fill=WHITE)

    # exclamation mark (accent color) inside triangle
    bar_w = size * 0.035
    bar_top = cy - tri_h * 0.16
    bar_bottom = cy + tri_h * 0.10
    d.rounded_rectangle(
        [cx - bar_w / 2, bar_top, cx + bar_w / 2, bar_bottom],
        radius=bar_w / 2,
        fill=ACCENT,
    )
    dot_r = bar_w * 0.85
    dot_cy = cy + tri_h * 0.22
    d.ellipse([cx - dot_r, dot_cy - dot_r, cx + dot_r, dot_cy + dot_r], fill=ACCENT)

    img.save(out_path)
    print(f"saved {out_path} ({size}x{size})")


make_icon(192, "../public/icons/icon-192.png")
make_icon(512, "../public/icons/icon-512.png")
make_icon(512, "../public/icons/icon-512-maskable.png", maskable=True)
