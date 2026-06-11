#!/usr/bin/env python3
"""
LingFang Logo Generator
Creates 1024x1024 app-icon.png — a modern geometric "gateway / L" mark.
Usage: python3 tools/generate_logo.py
"""

from PIL import Image, ImageDraw
import math, os

SIZE = 1024
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── Palette (indigo → violet → sky → cyan) ─────────────
C1 = (99, 102, 241)   # indigo-500
C2 = (139, 92, 246)   # violet-500
C3 = (56, 189, 248)   # sky-500
C4 = (34, 211, 238)   # cyan-400
C5 = (168, 85, 247)   # purple-500
BG  = (20, 20, 35)    # dark backdrop
# ────────────────────────────────────────────────────────

def lerp_color(a, b, t):
    return tuple(int(ac + (bc - ac) * t) for ac, bc in zip(a, b))

def gradient_h(x, x1, x2, c_from, c_to):
    """Horizontal gradient color at x between x1 and x2."""
    t = max(0, min(1, (x - x1) / (x2 - x1)))
    return lerp_color(c_from, c_to, t)

def gradient_v(y, y1, y2, c_from, c_to):
    """Vertical gradient color at y between y1 and y2."""
    t = max(0, min(1, (y - y1) / (y2 - y1)))
    return lerp_color(c_from, c_to, t)

def draw_rounded_rect(draw, x1, y1, x2, y2, r, fill_func):
    """Draw a rounded rectangle with per-pixel vertical gradient."""
    r = min(r, (x2 - x1) // 2, (y2 - y1) // 2)
    for y in range(y1, y2 + 1):
        color = fill_func(y)
        # Full row
        row_x1 = x1
        row_x2 = x2
        # Top/bottom rounded corners
        if y - y1 < r:
            dy = y - y1
            dx = int(math.sqrt(r * r - (r - dy) * (r - dy)))
            row_x1 += r - dx
            row_x2 -= r - dx
        elif y2 - y < r:
            dy = y2 - y
            dx = int(math.sqrt(r * r - (r - dy) * (r - dy)))
            row_x1 += r - dx
            row_x2 -= r - dx
        if row_x1 < row_x2:
            draw.rectangle([row_x1, y, row_x2, y + 1], fill=color)

def draw_rounded_rect_h(draw, x1, y1, x2, y2, r, fill_func):
    """Rounded rectangle with per-pixel horizontal gradient."""
    r = min(r, (x2 - x1) // 2, (y2 - y1) // 2)
    for x in range(x1, x2 + 1):
        color = fill_func(x)
        row_y1 = y1
        row_y2 = y2
        if x - x1 < r:
            dx = x - x1
            dy = int(math.sqrt(r * r - (r - dx) * (r - dx)))
            row_y1 += r - dy
            row_y2 -= r - dy
        elif x2 - x < r:
            dx = x2 - x
            dy = int(math.sqrt(r * r - (r - dx) * (r - dx)))
            row_y1 += r - dy
            row_y2 -= r - dy
        if row_y1 < row_y2:
            draw.rectangle([x, row_y1, x + 1, row_y2], fill=color)

def main():
    # ── Layer 0: transparent base ──
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(base)

    # ── Layer 1: dark rounded-square backdrop ──
    m = 80
    r = 200
    for y in range(m, SIZE - m):
        t = (y - m) / (SIZE - 2 * m)
        # subtle gradient on backdrop
        c = lerp_color((18, 18, 30), (25, 25, 40), t)
        row_x1, row_x2 = m, SIZE - m
        if y - m < r:
            dy = y - m
            dx = int(math.sqrt(r * r - (r - dy) * (r - dy)))
            row_x1 += r - dx
            row_x2 -= r - dx
        elif SIZE - m - y < r:
            dy = SIZE - m - y
            dx = int(math.sqrt(r * r - (r - dy) * (r - dy)))
            row_x1 += r - dx
            row_x2 -= r - dx
        if row_x1 < row_x2:
            draw.rectangle([row_x1, y, row_x2, y + 1], fill=c)

    # ── Layer 2: The "gateway L" mark ──
    # Vertical bar (left pillar)
    v_x1, v_x2 = 290, 370
    v_y1, v_y2 = 240, 680
    
    # Horizontal bar (top beam)
    h_x1, h_x2 = 290, 710
    h_y1, h_y2 = 240, 320

    r_bar = 40  # corner radius

    draw_rounded_rect(draw, v_x1, v_y1, v_x2, v_y2, r_bar,
                      lambda y: gradient_v(y, v_y1, v_y2, C1, C3))
    draw_rounded_rect_h(draw, h_x1, h_y1, h_x2, h_y2, r_bar,
                        lambda x: gradient_h(x, h_x1, h_x2, C1, C4))

    # ── Layer 3: accent diamond at the outer corner ──
    # Small diamond where the L turns
    dia_cx, dia_cy = 430, 380
    d_r = 32
    pts = [
        (dia_cx, dia_cy - d_r),
        (dia_cx + d_r, dia_cy),
        (dia_cx, dia_cy + d_r),
        (dia_cx - d_r, dia_cy),
    ]
    draw.polygon(pts, fill=C4)

    # ── Layer 4: subtle glow beneath ──
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    # Spread-out rectangles
    gdraw.rounded_rectangle(
        [v_x1 - 30, v_y1 - 30, v_x2 + 30, v_y2 + 30],
        radius=r_bar + 10, fill=(99, 102, 241, 40)
    )
    gdraw.rounded_rectangle(
        [h_x1 - 30, h_y1 - 30, h_x2 + 30, h_y2 + 30],
        radius=r_bar + 10, fill=(99, 102, 241, 40)
    )
    base = Image.alpha_composite(glow, base)

    # ── Save ──
    app_icon = os.path.join(BASE_DIR, "apps", "desktop", "app-icon.png")
    os.makedirs(os.path.dirname(app_icon), exist_ok=True)
    base.save(app_icon, "PNG")
    print(f"✅ app-icon.png  ({SIZE}x{SIZE})")

    # Also save as icon source for tauri
    icon_src = os.path.join(BASE_DIR, "apps", "desktop", "src-tauri", "icons", "icon.png")
    base.save(icon_src, "PNG")
    print(f"✅ icon.png")

if __name__ == "__main__":
    main()