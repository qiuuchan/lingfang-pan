#!/usr/bin/env python3
"""
LingFang NSIS 安装器侧边位图生成器

仅产出 NSIS 现代 UI (MUI2) 欢迎页/完成页左侧大图：
  - nsis-sidebar.bmp  164×314 24bpp

设计：复用 generate_logo.py 的品牌调色板（靛蓝→紫→天蓝→青）与几何 L 标，
在垂直渐变背景上绘制 LingFang L 标 + 品牌字样 + 副标题。

为什么不生成 header：精简安装器，顶部横幅区保持 NSIS 默认（无品牌横幅）。
为什么必须保留 sidebar：NSIS MUI2 欢迎页布局依赖 sidebar 位图占位，
移除会导致欢迎页文字区域消失（实战踩坑），故 sidebar 不可省。

NSIS sidebar 约束：
  - 164×314，显示在欢迎/完成页左侧；底部约 40px 被按钮区遮挡，
    有效绘制安全区为上部 ~274px，logo 与文字集中在安全区内。

用法：python tools/generate_nsis_sidebar.py
依赖：Pillow (PIL)
"""

from PIL import Image, ImageDraw, ImageFont
import os

# ── 品牌调色板（与 generate_logo.py 一致）─────────────
C1 = (99, 102, 241)   # indigo-500
C2 = (139, 92, 246)   # violet-500
C3 = (56, 189, 248)   # sky-500
C4 = (34, 211, 238)   # cyan-400

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "apps", "desktop", "src-tauri", "icons")


def lerp_color(a, b, t):
    return tuple(int(ac + (bc - ac) * t) for ac, bc in zip(a, b))


def gradient_v(w, h, c_top, c_bottom):
    """生成垂直渐变背景。"""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        col = lerp_color(c_top, c_bottom, t)
        for x in range(w):
            px[x, y] = col
    return img


def draw_rounded_rect(draw, x1, y1, x2, y2, r, fill):
    """画圆角矩形（24bpp 无 alpha，fill 为 RGB 元组）。"""
    draw.rounded_rectangle([x1, y1, x2, y2], radius=r, fill=fill)


def draw_l_mark(draw, ox, oy, scale):
    """在 (ox, oy) 处绘制 LingFang L 标（左竖柱 + 顶横梁 + 转角菱形）。
    基准几何来自 generate_logo.py（1024 画布），按 scale 缩放。"""
    # 基准几何（来自 generate_logo.py）
    v_x1, v_x2 = 290, 370
    v_y1, v_y2 = 240, 680
    h_x1, h_x2 = 290, 710
    h_y1, h_y2 = 240, 320
    r_bar = 40
    dia_cx, dia_cy, d_r = 430, 380, 32

    def s(v):
        return ox + v * scale

    def sy(v):
        return oy + v * scale

    # 竖柱：靛蓝
    draw_rounded_rect(draw, s(v_x1), sy(v_y1), s(v_x2), sy(v_y2),
                      max(1, int(r_bar * scale)), C1)
    # 横梁：靛蓝→青中段
    draw_rounded_rect(draw, s(h_x1), sy(h_y1), s(h_x2), sy(h_y2),
                      max(1, int(r_bar * scale)), lerp_color(C1, C4, 0.5))
    # 转角菱形点缀
    pts = [
        (s(dia_cx), sy(dia_cy - d_r)),
        (s(dia_cx + d_r), sy(dia_cy)),
        (s(dia_cx), sy(dia_cy + d_r)),
        (s(dia_cx - d_r), sy(dia_cy)),
    ]
    draw.polygon(pts, fill=C4)


def load_font(size):
    """加载中文字体（优先微软雅黑/黑体），失败回退默认。"""
    candidates = [
        "C:/Windows/Fonts/msyh.ttc",      # 微软雅黑
        "C:/Windows/Fonts/msyhbd.ttc",    # 微软雅黑 Bold
        "C:/Windows/Fonts/simhei.ttf",    # 黑体
        "C:/Windows/Fonts/arial.ttf",     # Arial 兜底
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def make_sidebar():
    """164×314 欢迎/完成页侧图：垂直渐变背景 + 居中 L 标 + 'LingFang' 字样 + 副标题。
    内容集中在上部安全区（底部 ~40px 被按钮遮挡）。"""
    w, h = 164, 314
    img = gradient_v(w, h, C1, C2)
    draw = ImageDraw.Draw(img)

    # L 标居中偏上（安全区内）
    scale = 0.16
    l_w = (710 - 290) * scale   # ≈ 67px
    l_h = (680 - 240) * scale   # ≈ 70px
    ox = (w - l_w) / 2 - 290 * scale
    oy = 70 - 240 * scale
    draw_l_mark(draw, ox=ox, oy=oy, scale=scale)

    # 品牌字样
    font = load_font(26)
    text = "LingFang"
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
    except Exception:
        tw, th = 80, 24
    tx = (w - tw) / 2
    ty = 70 + l_h + 16
    # 阴影增强对比
    draw.text((tx + 1, ty + 1), text, font=font, fill=(20, 20, 35))
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255))

    # 副标题
    font_sub = load_font(13)
    sub = "协作平台桌面客户端"
    try:
        bbox = draw.textbbox((0, 0), sub, font=font_sub)
        sw = bbox[2] - bbox[0]
    except Exception:
        sw = 90
    sx = (w - sw) / 2
    sy = ty + th + 8
    draw.text((sx, sy), sub, font=font_sub, fill=(220, 220, 240))

    out = os.path.join(OUT_DIR, "nsis-sidebar.bmp")
    img.save(out, "BMP")
    print(f"✅ nsis-sidebar.bmp  ({w}x{h})  {out}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    make_sidebar()


if __name__ == "__main__":
    main()
