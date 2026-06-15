#!/usr/bin/env python3
"""
LingFang NSIS 安装器资源生成器
生成 NSIS 安装界面所需的 BMP 横幅：
  - nsis-header.bmp   150x57   顶部横幅（NSIS 经典尺寸）
  - nsis-sidebar.bmp  164x314  侧边图（安装向导左侧）
品牌风格与 generate_logo.py 的 icon.png 一致（靛蓝→紫→天蓝渐变 + L 标）。
用法: py -3 tools/generate_installer_assets.py
"""

from PIL import Image, ImageDraw
import math
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(BASE_DIR, "apps", "desktop", "src-tauri", "icons")

# 品牌配色（与 generate_logo.py 同源）
C1 = (99, 102, 241)    # indigo-500
C2 = (139, 92, 246)    # violet-500
C3 = (56, 189, 248)    # sky-500
BG_DARK = (20, 20, 35)  # 深色底


def lerp(a, b, t):
    return tuple(int(ac + (bc - ac) * t) for ac, bc in zip(a, b))


def gradient_fill(img, horizontal=True):
    """对整图填充对角线渐变（indigo→violet→sky）。"""
    draw = ImageDraw.Draw(img)
    w, h = img.size
    diag = w + h
    for y in range(h):
        for x in range(w):
            # 对角进度（0..1），左上→右下
            t = (x + y) / diag if diag else 0
            if t < 0.5:
                c = lerp(C1, C2, t * 2)
            else:
                c = lerp(C2, C3, (t - 0.5) * 2)
            img.putpixel((x, y, ) , c + (255,))
    return img


def draw_l_mark(img, cx, cy, scale):
    """绘制品牌 L 标（竖柱 + 顶横梁），白色半透明，中心 cx,cy。"""
    draw = ImageDraw.Draw(img, "RGBA")
    # 竖柱（左）
    vw = int(36 * scale)
    vh = int(240 * scale)
    v_x1 = int(cx - 90 * scale)
    v_y1 = int(cy - vh / 2)
    draw.rectangle([v_x1, v_y1, v_x1 + vw, v_y1 + vh], fill=(255, 255, 255, 235))
    # 顶横梁
    hh = int(36 * scale)
    hw = int(180 * scale)
    h_x1 = v_x1
    h_y1 = v_y1
    draw.rectangle([h_x1, h_y1, h_x1 + hw, h_y1 + hh], fill=(255, 255, 255, 235))


def make_header():
    """150x57 顶部横幅（渐变 + L 标 + LingFang 字样留白）。BMP 24bit。"""
    img = Image.new("RGBA", (150, 57), BG_DARK + (255,))
    img = gradient_fill(img)
    # 小 L 标居左
    draw_l_mark(img, 45, 28, 0.18)
    # 转为 RGB（NSIS BMP 不支持 alpha）保存
    rgb = Image.new("RGB", img.size, BG_DARK)
    rgb.paste(img, mask=img.split()[3] if img.mode == "RGBA" else None)
    out = os.path.join(ICONS_DIR, "nsis-header.bmp")
    rgb.save(out, "BMP")
    print(f"已生成 {out}（{img.size}）")


def make_sidebar():
    """164x314 侧边图（纵向渐变 + 大 L 标居中偏上）。BMP 24bit。"""
    img = Image.new("RGBA", (164, 314), BG_DARK + (255,))
    img = gradient_fill(img)
    # 大 L 标居中偏上
    draw_l_mark(img, 82, 110, 0.42)
    rgb = Image.new("RGB", img.size, BG_DARK)
    rgb.paste(img, mask=img.split()[3] if img.mode == "RGBA" else None)
    out = os.path.join(ICONS_DIR, "nsis-sidebar.bmp")
    rgb.save(out, "BMP")
    print(f"已生成 {out}（{img.size}）")


def main():
    os.makedirs(ICONS_DIR, exist_ok=True)
    make_header()
    make_sidebar()
    print("NSIS 安装器资源生成完成。")


if __name__ == "__main__":
    main()
