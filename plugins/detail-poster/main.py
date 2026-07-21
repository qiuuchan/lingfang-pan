import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog, font as tkfont
from PIL import Image, ImageTk, ImageFilter, ImageGrab, ImageDraw, ImageFont, ImageOps
import os, threading, time, requests, base64, random, queue, mimetypes, json, subprocess, re, io, logging, sys
from pathlib import Path
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
import shutil

# ---------- 日志 ----------
logging.basicConfig(level=logging.INFO, format='%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
logger = logging.getLogger(__name__)
log_info = logger.info
log_error = logger.error

# ---------- 拖放支持 ----------
HAS_DND = False
try:
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(sys.executable)
        tkdnd_path = os.path.join(exe_dir, 'tkdnd')
        if os.path.exists(tkdnd_path):
            os.environ['TKDND_LIBRARY'] = tkdnd_path
        else:
            tkdnd_path = os.path.join(os.getcwd(), 'tkdnd')
            if os.path.exists(tkdnd_path):
                os.environ['TKDND_LIBRARY'] = tkdnd_path
    from tkinterdnd2 import DND_FILES, TkinterDnD
    HAS_DND = True
except Exception as e:
    log_error(f"拖放库加载失败: {e}")

# ---------- 平台桥配置 ----------
# AI 调用经平台本地桥，由桌面壳注入环境变量；插件不持有任何密钥或端点。
# 读取桥变量不得带 fallback 默认值（平台 AI 政策要求）。
_BRIDGE_URL = os.environ.get("LINGFANG_PLUGIN_BRIDGE_URL")
_BRIDGE_TOKEN = os.environ.get("LINGFANG_PLUGIN_BRIDGE_TOKEN")

# 档位：fast（快速）/ premium（高级），决定上游命中模型与计费；默认 fast。
TIER_CHOICES = ["fast", "premium"]
DEFAULT_TIER = "fast"

# ---------- 持久化目录（cwd=插件目录，data/ 由框架保证存在）----------
_DATA_DIR = os.path.join("data")
os.makedirs(_DATA_DIR, exist_ok=True)
TEMPLATE_FILE = os.path.join(_DATA_DIR, "templates.json")
STATE_FILE = os.path.join(_DATA_DIR, "app_state.json")
REVERSE_CONFIG_FILE = os.path.join(_DATA_DIR, "reverse_config.json")
COLOR_STATE_FILE = os.path.join(_DATA_DIR, "color_tool_state.json")
GPT55_CHAT_FILE = os.path.join(_DATA_DIR, "gpt55_chat_history.json")

# ---------- 字体（内置 fonts/ 目录 + 运行时探测系统字体 + 用户导入）----------
# 扫描插件自带 fonts/ 下 .ttf/.otf，建 显示名→路径 字典供颜色图工具加载。
# 文件名形如 `白无常可可体常规_mianfeiziti.com.ttf`，去 `_mianfeiziti.com` 与 ` (1)` 后缀取显示名。
BUILTIN_FONTS = {}
_FONT_FILE_SUFFIX = "_mianfeiziti.com"


def _scan_builtin_fonts():
    fonts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
    if not os.path.isdir(fonts_dir):
        return
    try:
        for fn in os.listdir(fonts_dir):
            if not fn.lower().endswith((".ttf", ".otf")):
                continue
            path = os.path.join(fonts_dir, fn)
            if not os.path.isfile(path):
                continue
            stem = os.path.splitext(fn)[0]
            stem = re.sub(r"\s*\(\d+\)\s*$", "", stem)  # 去重复下载的 ` (1)` 后缀
            if stem.endswith(_FONT_FILE_SUFFIX):
                stem = stem[: -len(_FONT_FILE_SUFFIX)]
            if stem and stem not in BUILTIN_FONTS:  # 同名去重，首个命中保留
                BUILTIN_FONTS[stem] = path
    except Exception as e:
        log_error(f"扫描内置字体失败: {e}")


_scan_builtin_fonts()


def bridge_ready():
    """是否在桌面壳内运行（桥变量已注入）。"""
    return bool(_BRIDGE_URL and _BRIDGE_TOKEN)


def _bridge_headers():
    return {"X-LingFang-Plugin-Token": _BRIDGE_TOKEN}


def bridge_image_edit(prompt, image_paths, tier="fast", n=1, size="1024x1024", timeout=(30, 600)):
    """经平台桥 /image/edit：参考图 + prompt → 返回 list[str]（data:URI 或 http URL）。"""
    images = []
    for p in image_paths:
        with open(p, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        mime = mimetypes.guess_type(p)[0] or "image/png"
        images.append({"filename": os.path.basename(p), "mimeType": mime, "data": b64})
    body = {"prompt": prompt, "images": images, "model": tier, "n": int(n), "size": size}
    resp = requests.post(_BRIDGE_URL + "/image/edit", json=body, headers=_bridge_headers(), timeout=timeout)
    if resp.status_code != 200:
        # 桥错误 body 含 code/message/requestId，拼进异常便于诊断（不丢上下文）
        try:
            ej = resp.json()
            raise Exception("桥 image.edit %s %s: %s%s" % (
                resp.status_code, ej.get("code", ""), ej.get("message", resp.text[:200]),
                (" (requestId=" + ej["requestId"] + ")") if ej.get("requestId") else ""))
        except ValueError:
            raise Exception("桥 image.edit %s: %s" % (resp.status_code, resp.text[:200]))
    return resp.json().get("images", [])


def bridge_chat(messages, tier="fast", timeout=(30, 300)):
    """经平台桥 /v1/chat/completions：返完整 relay 响应 dict（choices[0].message.content）。"""
    body = {"model": tier, "messages": messages}
    resp = requests.post(_BRIDGE_URL + "/v1/chat/completions", json=body, headers=_bridge_headers(), timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def fetch_image_bytes(src):
    """桥返回的图片可能是 data:URI 或 http URL，统一拿回字节。"""
    if src.startswith("data:"):
        _, b64 = src.split(",", 1)
        return base64.b64decode(b64)
    resp = requests.get(src, timeout=(10, 120))
    resp.raise_for_status()
    return resp.content

# ---------- 出图比例 → 上游标准 size / 目标精确像素 ----------
# 上游 image-edit 模型只认标准 size（1024x1024 / 1024x1536 / 1536x1024），任意自定义像素值
# （如 1254x1254 / 1440x2160）会被忽略（→ 出默认比例横图）或报错（→ 一键主图少出图）。
# 故请求层统一发标准 size；落盘前再用 Pillow center-crop 到目标精确像素，保证「选什么比例出什么比例」。
RATIO_STANDARD_SIZE = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "9:16": "1024x1536",
    "2:3": "1024x1536",
}
RATIO_PIXELS = {
    "1:1": (1024, 1024),
    "3:4": (1024, 1366),   # W:H = 3:4
    "9:16": (864, 1536),   # W:H = 9:16
    "2:3": (1024, 1536),   # W:H = 2:3
}


def _crop_to_ratio(img, ratio):
    """按目标比例裁切到精确像素，保留顶部（人物头肩在上 1/3，居中裁切会把头顶裁掉）。

    原来用 ImageOps.fit 做 center-crop：当源图比目标比例更高时，垂直方向上下各裁一半，
    直接把头顶切掉（详情图/海报的常见痛点）。改为：
      - 水平方向（源图更宽）仍 center-crop，左右对称；
      - 垂直方向（源图更高）改为顶部对齐 + 向下偏移 12%（保留头顶、留一点脚下空间）；
      - 先缩放到刚好覆盖目标，再按上面的偏移裁切到精确像素。
    ratio 不在表里或失败时原样返回。
    """
    target = RATIO_PIXELS.get(ratio)
    if not target:
        return img
    try:
        tw, th = target
        iw, ih = img.size
        # 缩放比：必须让缩放后宽≥目标宽 且 高≥目标高（cover），否则会拉伸变形。
        scale = max(tw / iw, th / ih)
        nw, nh = int(round(iw * scale)), int(round(ih * scale))
        resized = img.resize((nw, nh), Image.LANCZOS)
        # 水平居中，垂直偏顶（顶部偏移 12%，既不切头顶也不让脚下贴边）。
        left = (nw - tw) // 2
        top = int(round((nh - th) * 0.12)) if nh > th else 0
        # 限定到合法区间，防止极端输入溢出。
        top = max(0, min(top, nh - th))
        left = max(0, min(left, nw - tw))
        return resized.crop((left, top, left + tw, top + th))
    except Exception:
        return img

# ---------- 模块类 ----------
class PosterModule:
    def __init__(self, idx, is_sku=False):
        self.index = idx
        self.images = []
        self.prompt = ""
        self.size_ratio = "1:1"
        self.generated_image = None
        self.generated_image_path = None
        self.save_dir = None
        self.generated_filename = None
        self.status = "等待"
        self.widgets = {}
        self.is_sku = is_sku
        self.sku_name = ""
        self.mode = "normal"
        self.max_images = 10 if idx < 2 else 5

# ---------- 主应用 ----------
class App:
    def __init__(self, root):
        log_info("应用启动")
        self.root = root
        self.root.title("AI详情页海报生成器 v0.2.6")
        self.root.geometry("1600x900")
        self.root.configure(bg='#f0f2f5')
        try:
            _icon = os.path.join(os.path.dirname(__file__), 'app.ico')
            if os.path.exists(_icon):
                self.root.iconbitmap(default=_icon)
        except:
            pass

        self.modules = []
        self.max_modules = 20
        self.is_generating = False
        self.stop_gen = False
        self.ps_path = None
        self.upscale_paths = []
        self.ui_queue = queue.Queue()
        self.after_id = None
        self.process_ui_queue()
        self._setup_style()
        self.setup_ui()
        self.preview_fit_mode = "fit"
        self.load_reverse_config()
        self.load_color_state()
        self.load_gpt55_history()
        # 以下属性在 load_state / add_module / save_state 链路中被访问，必须在 load_state 之前初始化，
        # 否则首次运行（无状态文件）add_module→save_state 会因 AttributeError 崩溃。
        self.main_images_dir = None
        self.global_save_dir = None
        self.file_lock = threading.Lock()
        if not self.load_state():
            for _ in range(6):
                self.add_module()
        self.templates = {}
        self.categories = []
        self.current_category = ""
        self.cat_btns = {}
        self.load_templates()
        self.root.update_idletasks()
        self._apply_sash_limits()
        self.preview_zoom = 1.0
        self.preview_offset_x = 0
        self.preview_offset_y = 0
        self.current_preview_items = []
        self._preview_photos = []
        self._zoom_timer = None

        self.reverse_filled_count = 0

        self.drag_data = None
        self.drag_from_preview = False
        self.gpt55_win = None
        self.gpt55_img_paths = []
        self.gpt55_conversation = []  # 上下文对话历史
        self.gpt55_loading = None
        self.gpt55_mode = "text"     # 文本模式或代码模式

        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)
        self.root.after(100, self._lazy_init)

    def _lazy_init(self):
        log_info("懒加载完成")

    def process_ui_queue(self):
        try:
            while True:
                func, args = self.ui_queue.get_nowait()
                func(*args)
        except queue.Empty:
            pass
        self.after_id = self.root.after(50, self.process_ui_queue)

    def safe_ui(self, func, *args):
        self.ui_queue.put((func, args))

    # ---------- 现代扁平主题 ----------
    def _setup_style(self):
        """clam 基底 + 统一色板，让 ttk 控件呈现现代扁平外观（不改 tk.* 工具栏色块编码）。"""
        style = ttk.Style()
        try:
            style.theme_use('clam')
        except Exception:
            pass
        BG = '#f0f2f5'          # 与各处 tk.Frame(bg=...) 一致，避免 ttk/tk 色差
        CARD = '#ffffff'
        TEXT = '#1f2937'
        MUTED = '#6b7280'
        BORDER = '#d1d5db'
        ACCENT = '#3b82f6'
        ACCENT_HOVER = '#2563eb'
        style.configure('.', background=BG, foreground=TEXT, font=('Arial', 10), borderwidth=0)
        style.configure('TFrame', background=BG)
        style.configure('TLabel', background=BG, foreground=TEXT)
        style.configure('TLabelframe', background=CARD, relief='flat', borderwidth=1, padding=8)
        style.configure('TLabelframe.Label', background=CARD, foreground=TEXT, font=('Arial', 10, 'bold'))
        style.configure('TButton', padding=(12, 6), font=('Arial', 10), background=CARD,
                        foreground=TEXT, borderwidth=1, relief='flat', focusthickness=2, focuscolor=ACCENT)
        style.map('TButton', background=[('active', '#e5e7eb')], bordercolor=[('focus', ACCENT)])
        style.configure('Accent.TButton', padding=(14, 7), font=('Arial', 10, 'bold'),
                        background=ACCENT, foreground='#ffffff', relief='flat')
        style.map('Accent.TButton', background=[('active', ACCENT_HOVER), ('disabled', '#9ca3af')])
        style.configure('TEntry', padding=6, fieldbackground=CARD, foreground=TEXT,
                        bordercolor=BORDER, lightcolor=BORDER, darkcolor=BORDER, borderwidth=1)
        style.map('TEntry', bordercolor=[('focus', ACCENT)], lightcolor=[('focus', ACCENT)])
        style.configure('TCombobox', padding=5, fieldbackground=CARD, foreground=TEXT,
                        bordercolor=BORDER, lightcolor=BORDER, darkcolor=BORDER, borderwidth=1, arrowcolor=MUTED)
        style.map('TCombobox', bordercolor=[('focus', ACCENT)], lightcolor=[('focus', ACCENT)],
                  fieldbackground=[('readonly', CARD)])
        style.configure('TCheckbutton', background=BG, foreground=TEXT)
        style.configure('TRadiobutton', background=BG, foreground=TEXT)
        style.configure('TScale', background=BG)
        style.configure('TSpinbox', padding=4, fieldbackground=CARD, foreground=TEXT,
                        bordercolor=BORDER, arrowcolor=MUTED)
        style.configure('TProgressbar', background=ACCENT, troughcolor='#e5e7eb', borderwidth=0)
        style.configure('TScrollbar', background=CARD, troughcolor=BG, borderwidth=0, arrowcolor=MUTED)
        style.map('TScrollbar', background=[('active', BORDER)])

    # ---------- 配置加载/保存 ----------
    def load_reverse_config(self):
        self.tier = DEFAULT_TIER
        if os.path.exists(REVERSE_CONFIG_FILE):
            try:
                with open(REVERSE_CONFIG_FILE, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                self.tier = cfg.get('tier', DEFAULT_TIER)
                if self.tier not in TIER_CHOICES:
                    self.tier = DEFAULT_TIER
                self.reverse_state = cfg.get('reverse_state', {})
                self.ps_path = cfg.get('ps_path', None)
                if self.ps_path and not os.path.exists(self.ps_path):
                    self.ps_path = None
                log_info("配置加载完成")
            except Exception as e:
                log_error(f"加载配置失败: {e}")
                self.reverse_state = {}
                self.ps_path = None
        else:
            self.reverse_state = {}
            self.ps_path = None

    def save_reverse_config(self):
        cfg = {
            'tier': self.tier,
            'reverse_state': self.reverse_state,
            'ps_path': self.ps_path
        }
        try:
            with open(REVERSE_CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
            log_info("配置已保存")
        except Exception as e:
            log_error(f"保存配置失败: {e}")

    # ---------- GPT5.5 历史 ----------
    def load_gpt55_history(self):
        self.gpt55_chats = []
        if os.path.exists(GPT55_CHAT_FILE):
            try:
                with open(GPT55_CHAT_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                cutoff = datetime.now() - timedelta(days=3)
                for item in data:
                    ts = item.get('timestamp', '')
                    try:
                        t = datetime.fromisoformat(ts)
                        if t > cutoff:
                            self.gpt55_chats.append(item)
                    except:
                        continue
                log_info(f"加载GPT5.5对话记录: {len(self.gpt55_chats)} 条")
            except:
                self.gpt55_chats = []
        else:
            self.gpt55_chats = []

    def save_gpt55_history(self):
        try:
            with open(GPT55_CHAT_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.gpt55_chats, f, ensure_ascii=False, indent=2)
            log_info("GPT5.5对话记录已保存")
        except Exception as e:
            log_error(f"保存GPT5.5对话记录失败: {e}")

    # ---------- 颜色图状态 ----------
    def load_color_state(self):
        self.color_state = {}
        if os.path.exists(COLOR_STATE_FILE):
            try:
                with open(COLOR_STATE_FILE, 'r', encoding='utf-8') as f:
                    self.color_state = json.load(f)
                log_info("颜色图状态已加载")
            except:
                pass
        self.color_state.setdefault('img_path', '')
        self.color_state.setdefault('text_lines', ['', '', ''])
        self.color_state.setdefault('font_sizes', [24, 24, 24])
        self.color_state.setdefault('stretch_width', 80)
        self.color_state.setdefault('font_name', '白无常可可体常规')
        self.color_state.setdefault('y_offsets', [490, 606, 710])
        self.color_state.setdefault('x_offsets', [0, 0, 0])
        self.color_state.setdefault('h_offset', 0)
        self.color_state.setdefault('preview_scale', 1.0)
        self.color_state.setdefault('bold', False)
        self.color_state.setdefault('italic', False)
        self.color_state.setdefault('font_path', '')
        self.color_state.setdefault('imported_fonts', [])
        self.color_state.setdefault('text_color', 'black')

    def save_color_state(self):
        try:
            with open(COLOR_STATE_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.color_state, f, ensure_ascii=False, indent=2)
            log_info("颜色图状态已保存")
        except:
            pass

    # ---------- 分割线限制 ----------
    def _apply_sash_limits(self):
        def on_sash_drag(event):
            current = self.main_paned.sashpos(0)
            if current < 720:
                self.main_paned.sashpos(0, 720)
            elif current > 1116:
                self.main_paned.sashpos(0, 1116)
        self.main_paned.bind("<B1-Motion>", on_sash_drag)
        self.root.bind("<Configure>", lambda e: self.root.after(10, self._adjust_sash))

    def _adjust_sash(self):
        cur = self.main_paned.sashpos(0)
        if cur < 720: self.main_paned.sashpos(0, 720)
        elif cur > 1116: self.main_paned.sashpos(0, 1116)

    def _on_left_scroll(self, event):
        self.left_canvas.yview_scroll(int(-1*(event.delta/120)), "units")
        return "break"

    def _bind_scroll_recursive(self, widget):
        widget.bind("<MouseWheel>", self._on_left_scroll)
        for child in widget.winfo_children():
            self._bind_scroll_recursive(child)

    # ---------- UI 布局 ----------
    def setup_ui(self):
        self.main_paned = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        self.main_paned.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        left = ttk.Frame(self.main_paned)
        self.main_paned.add(left, weight=1)

        # 顶部工具栏
        tb = ttk.Frame(left)
        tb.pack(fill=tk.X, pady=(0,5))

        row1 = ttk.Frame(tb)
        row1.pack(fill=tk.X)
        btn_config = [
            ("🔧设置", self.open_settings, "#ADD8E6"),
            ("🎨设计", self.open_design, "#DDA0DD"),
            ("🔄反推提示词", self.reverse_prompt, "#FFD700"),
            ("🚀生成全部", self.gen_all, "#90EE90"),
            ("🗑️清空全部", self.clear_all, "#FFFACD"),
            ("📝一键保存详情页", self.save_detail, "#FFC0CB"),
            ("🎨颜色图", self.open_color_sku_tool, "#FFB6C1"),
            ("GPT5.5", self.open_gpt55_chat, "#9B59B6"),
        ]
        for txt, cmd, color in btn_config:
            btn = tk.Button(row1, text=txt, command=cmd, bg=color, relief=tk.RAISED, font=('Arial',10,'bold'), padx=5, pady=2)
            btn.pack(side=tk.LEFT, padx=2)

        self.status = tk.StringVar(value="就绪")
        ttk.Label(left, textvariable=self.status, relief=tk.SUNKEN, background='#fff', anchor='w', padding=4).pack(fill=tk.X, pady=(0,5))

        # 模板库
        tf = ttk.LabelFrame(left, text="📝 提示词模板库", padding=5)
        tf.pack(fill=tk.X, pady=(0,5))
        self.tpl_frame = tk.Frame(tf, bg='#f0f2f5', height=280)
        self.tpl_frame.pack(fill=tk.BOTH, expand=True)

        cat_canvas = tk.Canvas(self.tpl_frame, height=40, bg='#f0f2f5', highlightthickness=0)
        cat_scroll = ttk.Scrollbar(self.tpl_frame, orient=tk.HORIZONTAL, command=cat_canvas.xview)
        cat_inner = tk.Frame(cat_canvas, bg='#f0f2f5')
        cat_canvas.create_window((0,0), window=cat_inner, anchor='nw')
        cat_canvas.configure(xscrollcommand=cat_scroll.set)
        cat_canvas.pack(side=tk.TOP, fill=tk.X, pady=(0,5))
        cat_scroll.pack(side=tk.TOP, fill=tk.X)
        self.cat_canvas = cat_canvas
        self.cat_inner = cat_inner
        cat_canvas.bind("<MouseWheel>", self._on_cat_scroll)

        tpl_canvas = tk.Canvas(self.tpl_frame, height=200, bg='#f0f2f5', highlightthickness=0)
        tpl_scroll = ttk.Scrollbar(self.tpl_frame, orient=tk.HORIZONTAL, command=tpl_canvas.xview)
        tpl_inner = tk.Frame(tpl_canvas, bg='#f0f2f5')
        tpl_canvas.create_window((0,0), window=tpl_inner, anchor='nw')
        tpl_canvas.configure(xscrollcommand=tpl_scroll.set)
        tpl_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        tpl_scroll.pack(side=tk.BOTTOM, fill=tk.X)
        self.tpl_canvas = tpl_canvas
        self.tpl_inner = tpl_inner
        tpl_canvas.bind("<MouseWheel>", self._on_tpl_scroll)

        btn_row = tk.Frame(tf, bg='#f0f2f5')
        btn_row.pack(fill=tk.X, pady=2)
        tk.Button(btn_row, text="添加提示词模块", command=self.add_tpl, bg='#d0e0f0').pack(side=tk.LEFT, padx=2)
        tk.Button(btn_row, text="批量导入", command=self.batch_import_templates, bg='#d0e0f0').pack(side=tk.LEFT, padx=2)

        # 模块容器
        mc = ttk.LabelFrame(left, text="📦 详情主图SKU模块", padding=5)
        mc.pack(fill=tk.BOTH, expand=True)
        canvas = tk.Canvas(mc, bg='#f0f2f5', highlightthickness=0)
        vsb = ttk.Scrollbar(mc, orient=tk.VERTICAL, command=canvas.yview)
        outer_frame = tk.Frame(canvas, bg='#f0f2f5')
        self.module_frame = tk.Frame(outer_frame, bg='#f0f2f5')
        self.module_frame.pack(fill=tk.BOTH, expand=True)
        self.canvas_window = canvas.create_window((0,0), window=outer_frame, anchor='nw')
        canvas.configure(yscrollcommand=vsb.set)
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)
        self.left_canvas = canvas
        self.outer_frame = outer_frame
        self.left_canvas.bind("<MouseWheel>", self._on_left_scroll)
        self.outer_frame.bind("<MouseWheel>", self._on_left_scroll)
        self.module_frame.bind("<MouseWheel>", self._on_left_scroll)
        def on_canvas_configure(event):
            canvas.itemconfig(self.canvas_window, width=event.width)
        canvas.bind("<Configure>", on_canvas_configure)

        ab = ttk.Frame(left)
        ab.pack(fill=tk.X, pady=5)
        self.add_btn = ttk.Button(ab, text="➕ 添加模块", command=self.add_module, width=10)
        self.add_btn.pack(side=tk.LEFT, padx=2)
        ttk.Button(ab, text="添加5个", command=lambda: self.add_n(5)).pack(side=tk.LEFT, padx=2)
        ttk.Button(ab, text="添加10个", command=lambda: self.add_n(10)).pack(side=tk.LEFT, padx=2)
        ttk.Button(ab, text="添加20个(满)", command=lambda: self.add_n(20)).pack(side=tk.LEFT, padx=2)
        ttk.Button(ab, text="添加4个SKU", command=lambda: self.add_sku_modules(4)).pack(side=tk.LEFT, padx=2)
        ttk.Button(ab, text="➖ 减少模块", command=self.remove_module).pack(side=tk.LEFT, padx=2)
        self.prog_label = ttk.Label(ab, text="", foreground="#2980b9")
        self.prog_label.pack(side=tk.RIGHT, padx=5)

        # 右侧预览区
        right = ttk.Frame(self.main_paned)
        self.main_paned.add(right, weight=1)
        ph = ttk.Frame(right)
        ph.pack(fill=tk.X, pady=(0,5))
        ttk.Label(ph, text="📷 预览区", font=('Arial',12,'bold')).pack(side=tk.LEFT)
        self.preview_mode = tk.StringVar(value="整体预览")
        for mode in ["整体预览", "分开预览", "主图预览"]:
            ttk.Radiobutton(ph, text=mode, variable=self.preview_mode, value=mode, command=self.switch_preview).pack(side=tk.LEFT, padx=5)
        self.fit_btn = ttk.Button(ph, text="1:1", command=self.toggle_preview_fit, width=5)
        self.fit_btn.pack(side=tk.LEFT, padx=10)

        self.progress = tk.IntVar(value=0)
        ttk.Progressbar(right, variable=self.progress, maximum=100, length=200).pack(fill=tk.X, pady=5)

        self.preview_canvas = tk.Canvas(right, bg='white', highlightthickness=1)
        self.preview_canvas.pack(fill=tk.BOTH, expand=True)
        v2 = ttk.Scrollbar(right, orient=tk.VERTICAL, command=self.preview_canvas.yview)
        h2 = ttk.Scrollbar(right, orient=tk.HORIZONTAL, command=self.preview_canvas.xview)
        self.preview_canvas.configure(yscrollcommand=v2.set, xscrollcommand=h2.set)
        v2.pack(side=tk.RIGHT, fill=tk.Y)
        h2.pack(side=tk.BOTTOM, fill=tk.X)
        self.preview_canvas.bind("<MouseWheel>", self._on_preview_scroll)
        self.preview_canvas.bind("<Double-Button-1>", self._on_preview_double)
        self.preview_canvas.bind("<Control-MouseWheel>", self._on_preview_ctrl_scroll)

        self.save_long_btn = ttk.Button(right, text="💾 保存长图", command=self.save_long)
        self.save_long_btn.pack(side=tk.BOTTOM, pady=5)
        self.save_long_btn.pack_forget()

        self.switch_preview()
        self.root.after(100, self._adjust_sash)

    # ---------- 分类/模板滚轮 ----------
    def _on_cat_scroll(self, event):
        if event.num == 4 or event.delta > 0:
            self.cat_canvas.xview_scroll(-1, "units")
        elif event.num == 5 or event.delta < 0:
            self.cat_canvas.xview_scroll(1, "units")
        return "break"

    def _on_tpl_scroll(self, event):
        if event.num == 4 or event.delta > 0:
            self.tpl_canvas.xview_scroll(-1, "units")
        elif event.num == 5 or event.delta < 0:
            self.tpl_canvas.xview_scroll(1, "units")
        return "break"

    # ---------- 预览模式切换 ----------
    def toggle_preview_fit(self):
        if self.preview_fit_mode == "fit":
            self.preview_fit_mode = "1to1"
            self.fit_btn.config(text="适应")
            self.preview_zoom = 1.0
        else:
            self.preview_fit_mode = "fit"
            self.fit_btn.config(text="1:1")
            self.preview_zoom = 1.0
        self.switch_preview()

    # ---------- 设置窗口 ----------
    def open_settings(self):
        d = tk.Toplevel(self.root)
        d.title("设置")
        d.geometry("560x520")
        d.transient(self.root)

        ttk.Label(d, text="【档位设置】", font=('Arial',12,'bold')).pack(pady=(10,0), anchor=tk.W, padx=20)
        tier_frame = ttk.Frame(d)
        tier_frame.pack(fill=tk.X, padx=20, pady=8)
        ttk.Label(tier_frame, text="生图/反推档位:").pack(side=tk.LEFT, padx=5)
        tier_var = tk.StringVar(value=self.tier)
        for t in TIER_CHOICES:
            ttk.Radiobutton(tier_frame, text=f"{t}（{'高级' if t == 'premium' else '快速'}）",
                            variable=tier_var, value=t).pack(side=tk.LEFT, padx=8)
        ttk.Label(d, text="档位决定上游命中模型与计费（premium 质量更高、计费更多）。AI 调用经平台桥，按团队灵石计费。",
                  foreground='#666', font=('Arial',9), wraplength=500).pack(padx=20, anchor=tk.W)

        ttk.Label(d, text="【全局保存目录】", font=('Arial',12,'bold')).pack(pady=(15,0), anchor=tk.W, padx=20)
        dir_frame = ttk.Frame(d)
        dir_frame.pack(fill=tk.X, padx=20, pady=5)
        dir_label = ttk.Label(dir_frame, text=self.global_save_dir or "未设置（使用模块原路径）", foreground='blue')
        dir_label.pack(side=tk.LEFT, fill=tk.X, expand=True)
        def set_dir():
            dirpath = filedialog.askdirectory(title="选择全局保存目录")
            if dirpath:
                self.global_save_dir = dirpath
                dir_label.config(text=dirpath)
                self.status.set(f"全局目录已设置: {dirpath}")
        ttk.Button(dir_frame, text="选择目录", command=set_dir).pack(side=tk.RIGHT, padx=5)

        ttk.Label(d, text="【Photoshop 路径】", font=('Arial',12,'bold')).pack(pady=(15,0), anchor=tk.W, padx=20)
        ps_frame = ttk.Frame(d)
        ps_frame.pack(fill=tk.X, padx=20, pady=5)
        ps_label = ttk.Label(ps_frame, text=self.ps_path or "未设置", foreground='blue')
        ps_label.pack(side=tk.LEFT, fill=tk.X, expand=True)
        def set_ps():
            p = filedialog.askopenfilename(title="选择Photoshop.exe", filetypes=[("Exe","*.exe")])
            if p:
                self.ps_path = p
                ps_label.config(text=p)
                self.status.set(f"PS路径已设置: {p}")
                self.save_reverse_config()
        ttk.Button(ps_frame, text="选择PS", command=set_ps).pack(side=tk.RIGHT, padx=5)

        def save_all():
            new_tier = tier_var.get()
            if new_tier in TIER_CHOICES:
                self.tier = new_tier
            self.save_reverse_config()
            d.destroy()
            self.status.set("设置已保存")
        ttk.Button(d, text="保存设置", command=save_all).pack(pady=20)
        def on_close():
            save_all()
        d.protocol("WM_DELETE_WINDOW", on_close)

    # ---------- 设计窗口 ----------
    def open_design(self):
        d = tk.Toplevel(self.root)
        d.title("设计工具")
        d.geometry("500x450")
        d.transient(self.root)
        ttk.Label(d, text="拼成长图", font=('Arial',12,'bold')).pack(pady=(10,0), anchor=tk.W, padx=20)
        ttk.Button(d, text="拼成长图", command=self.merge_long, width=20).pack(pady=5)

        ttk.Label(d, text="4K/8K 高清修复", font=('Arial',12,'bold')).pack(pady=(15,0), anchor=tk.W, padx=20)
        ttk.Button(d, text="打开高清修复", command=self.open_upscale, width=20).pack(pady=5)

        ttk.Label(d, text="修改详情图尺寸", font=('Arial',12,'bold')).pack(pady=(15,0), anchor=tk.W, padx=20)
        detail_frame = ttk.Frame(d)
        detail_frame.pack(fill=tk.X, padx=20, pady=5)
        ttk.Label(detail_frame, text="目标宽度:").pack(side=tk.LEFT, padx=5)
        detail_width = tk.StringVar(value="790")
        for w in ["790", "750", "1086"]:
            ttk.Radiobutton(detail_frame, text=w, variable=detail_width, value=w).pack(side=tk.LEFT, padx=5)
        ttk.Button(d, text="选择图片并调整", command=lambda: self.resize_images("detail", int(detail_width.get()))).pack(pady=5)

        ttk.Label(d, text="修改主图尺寸", font=('Arial',12,'bold')).pack(pady=(15,0), anchor=tk.W, padx=20)
        main_frame = ttk.Frame(d)
        main_frame.pack(fill=tk.X, padx=20, pady=5)
        ttk.Label(main_frame, text="尺寸类型:").pack(side=tk.LEFT, padx=5)
        main_type = tk.StringVar(value="方图")
        ttk.Radiobutton(main_frame, text="方图", variable=main_type, value="方图").pack(side=tk.LEFT, padx=5)
        ttk.Radiobutton(main_frame, text="竖图3:4", variable=main_type, value="竖图3:4").pack(side=tk.LEFT, padx=5)
        ttk.Radiobutton(main_frame, text="竖图2:3", variable=main_type, value="竖图2:3").pack(side=tk.LEFT, padx=5)

        size_frame = ttk.Frame(d)
        size_frame.pack(fill=tk.X, padx=20, pady=5)
        ttk.Label(size_frame, text="具体尺寸:").pack(side=tk.LEFT, padx=5)
        main_size = tk.StringVar()
        size_combo = ttk.Combobox(size_frame, textvariable=main_size, width=15)
        size_combo.pack(side=tk.LEFT, padx=5)

        def update_sizes(*args):
            t = main_type.get()
            if t == "方图":
                size_combo['values'] = ["1440x1440", "1200x1200", "1000x1000", "800x800"]
            elif t == "竖图3:4":
                size_combo['values'] = ["1440x1920", "1200x1600", "1000x1333", "800x1066"]
            elif t == "竖图2:3":
                size_combo['values'] = ["1440x2160", "1200x1800", "1000x1500", "800x1200"]
            if size_combo['values']:
                size_combo.set(size_combo['values'][0])
        main_type.trace_add('write', lambda *args: update_sizes())
        update_sizes()

        def start_main_resize():
            size_str = main_size.get()
            if not size_str:
                messagebox.showwarning("提示", "请选择具体尺寸")
                return
            w, h = map(int, size_str.split('x'))
            self.resize_images("main", w, h)
        ttk.Button(d, text="选择图片并调整", command=start_main_resize).pack(pady=5)

        ttk.Button(d, text="关闭", command=d.destroy).pack(pady=10)

    # ---------- 图片尺寸调整 ----------
    def resize_images(self, mode, *args):
        paths = filedialog.askopenfilenames(title="选择图片", filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp")])
        if not paths:
            return
        if mode == "detail":
            target_w = args[0]
            self._do_resize_detail(paths, target_w)
        else:
            target_w, target_h = args[0], args[1]
            self._do_resize_main(paths, target_w, target_h)

    def _do_resize_detail(self, paths, target_w):
        total = len(paths)
        self.safe_ui(self.status.set, f"开始调整详情图，共 {total} 张...")
        for i, src in enumerate(paths, 1):
            try:
                img = Image.open(src)
                w, h = img.size
                ratio = target_w / w
                new_h = int(h * ratio)
                resized = img.resize((target_w, new_h), Image.LANCZOS)
                base, ext = os.path.splitext(src)
                dst = f"{base}_{target_w}{ext}"
                if ext.lower() in ['.jpg', '.jpeg']:
                    resized.save(dst, quality=100, subsampling=0)
                else:
                    resized.save(dst, quality=100, subsampling=0)
                self.safe_ui(self.status.set, f"详情图进度: {i}/{total} - {os.path.basename(dst)}")
            except Exception as e:
                self.safe_ui(self.status.set, f"调整失败: {os.path.basename(src)} - {e}")
        self.safe_ui(self.status.set, f"详情图调整完成，共 {total} 张")

    def _do_resize_main(self, paths, target_w, target_h):
        total = len(paths)
        self.safe_ui(self.status.set, f"开始调整主图，共 {total} 张...")
        for i, src in enumerate(paths, 1):
            try:
                img = Image.open(src)
                resized = img.resize((target_w, target_h), Image.LANCZOS)
                base, ext = os.path.splitext(src)
                dst = f"{src}_{target_w}x{target_h}{ext}"
                if ext.lower() in ['.jpg', '.jpeg']:
                    resized.save(dst, quality=100, subsampling=0)
                else:
                    resized.save(dst, quality=100, subsampling=0)
                self.safe_ui(self.status.set, f"主图进度: {i}/{total} - {os.path.basename(dst)}")
            except Exception as e:
                self.safe_ui(self.status.set, f"调整失败: {os.path.basename(src)} - {e}")
        self.safe_ui(self.status.set, f"主图调整完成，共 {total} 张")

    # ---------- 反推提示词 ----------
    def reverse_prompt(self):
        d = tk.Toplevel(self.root)
        d.title("🔄 反推提示词（增强版）")
        d.geometry("840x840")
        d.transient(self.root)

        state = self.reverse_state
        self.reverse_filled_count = 0

        tk.Label(d, text="1. 选择参考图片（最多10张）：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=20, pady=(10,5))
        self.reverse_images = state.get('images', [])
        img_label = tk.Label(d, text=f"已选 {len(self.reverse_images)} 张图片" if self.reverse_images else "未选择任何图片", fg='blue', bg='#f0f2f5')
        img_label.pack(fill=tk.X, padx=20, pady=5)

        def pick_images():
            paths = filedialog.askopenfilenames(title="选择参考图片", filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp")])
            try:
                if paths:
                    if len(paths) > 10:
                        paths = paths[:10]
                    self.reverse_images = list(paths)
                    img_label.config(text=f"已选 {len(paths)} 张图片")
                    state['images'] = self.reverse_images
                    log_info(f"反推图片已选择: {len(paths)} 张")
                else:
                    self.reverse_images = []
                    img_label.config(text="未选择任何图片")
                    state['images'] = []
                    log_info("反推图片已清空")
                self.save_reverse_config()
            except Exception as e:
                log_error(f"选择/清空图片时发生异常: {e}")
                messagebox.showerror("错误", f"操作失败: {e}")

        tk.Button(d, text="选择图片", command=pick_images).pack(pady=5)

        tk.Label(d, text="2. 海报主题：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=20, pady=(10,5))
        theme_entry = tk.Entry(d, width=60, font=('Arial',10))
        theme_entry.insert(0, state.get('theme', ''))
        theme_entry.pack(padx=20, fill=tk.X, pady=5)

        tk.Label(d, text="3. 服装基本信息：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=20, pady=(10,5))
        cloth_entry = tk.Entry(d, width=60, font=('Arial',10))
        cloth_entry.insert(0, state.get('cloth_info', ''))
        cloth_entry.pack(padx=20, fill=tk.X, pady=5)

        tk.Label(d, text="4. 场景描述：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=20, pady=(10,5))
        scene_entry = tk.Entry(d, width=60, font=('Arial',10))
        scene_entry.insert(0, state.get('scene', ''))
        scene_entry.pack(padx=20, fill=tk.X, pady=5)

        tk.Label(d, text="5. 性别选项：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=20, pady=(10,5))
        gender_frame = tk.Frame(d)
        gender_frame.pack(anchor=tk.W, padx=20, pady=5)
        gender_var = tk.StringVar(value=state.get('gender', '女'))
        tk.Radiobutton(gender_frame, text="女", variable=gender_var, value="女").pack(side=tk.LEFT, padx=10)
        tk.Radiobutton(gender_frame, text="男", variable=gender_var, value="男").pack(side=tk.LEFT, padx=10)
        tk.Radiobutton(gender_frame, text="男女款", variable=gender_var, value="男女款").pack(side=tk.LEFT, padx=10)

        style_frame = ttk.Frame(d)
        style_frame.pack(fill=tk.X, padx=20, pady=5)
        ttk.Label(style_frame, text="字体：").pack(side=tk.LEFT, padx=5)
        font_var = tk.StringVar(value=state.get('font', '思源黑体-Medium'))
        font_combo = ttk.Combobox(style_frame, textvariable=font_var, width=25,
                                  values=["SF Pro Display", "微软雅黑", "思源黑体-Medium", "思源黑体-Heavy",
                                          "思源宋体-Medium", "hand-lettered script with brushstrokes"])
        font_combo.pack(side=tk.LEFT, padx=5)
        ttk.Label(style_frame, text="字号（主标题）：").pack(side=tk.LEFT, padx=10)
        size_var = tk.IntVar(value=state.get('font_size', 48))
        size_combo = ttk.Combobox(style_frame, textvariable=size_var, width=10, values=list(range(30,81)))
        size_combo.pack(side=tk.LEFT, padx=5)

        detail_var = tk.BooleanVar(value=state.get('detail_mode', False))
        tk.Checkbutton(d, text="□ 细节材质图（无模特）", variable=detail_var,
                       command=lambda: setattr(state, 'detail_mode', detail_var.get())).pack(anchor=tk.W, padx=20, pady=5)

        tk.Label(d, text="8. 文案补充（可选）：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=20, pady=(10,5))
        copy_frame = tk.Frame(d, height=80)
        copy_frame.pack(fill=tk.X, padx=20, pady=5)
        copy_frame.pack_propagate(False)
        copy_text = tk.Text(copy_frame, wrap=tk.WORD, font=('Arial',10), height=3, bg='#fafafa')
        copy_text.insert("1.0", state.get('extra_copy', ''))
        copy_scroll = ttk.Scrollbar(copy_frame, orient=tk.VERTICAL, command=copy_text.yview)
        copy_text.configure(yscrollcommand=copy_scroll.set)
        copy_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        copy_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        btn_frame = ttk.Frame(d)
        btn_frame.pack(pady=10)

        def copy_all():
            content = preview_text.get("1.0", tk.END).strip()
            if content:
                d.clipboard_clear(); d.clipboard_append(content); d.update()
                self.status.set("已复制全部反推结果到剪贴板")

        def fill_to_modules():
            content = preview_text.get("1.0", tk.END).strip()
            if not content:
                messagebox.showwarning("提示", "预览框为空，无可填入的内容")
                return
            entries = [e.strip() for e in content.split('\n\n') if e.strip()]
            if not entries:
                messagebox.showwarning("提示", "未检测到有效的条目，请确保每条之间用空行分隔")
                return
            start_idx = self.reverse_filled_count
            if start_idx >= len(entries):
                messagebox.showinfo("提示", "没有新的条目需要填入")
                return
            for i in range(start_idx, len(entries)):
                entry = entries[i]
                lines = entry.split('\n')
                if not lines: continue
                title_line = lines[0].strip()
                if title_line.startswith('标题：'):
                    title = title_line[3:].strip()
                else:
                    title = title_line
                prompt_lines = []
                for line in lines[1:]:
                    if line.startswith('提示词：'):
                        prompt_lines.append(line[4:].strip())
                    else:
                        prompt_lines.append(line.strip())
                prompt = '\n'.join(prompt_lines).strip()
                if not prompt: prompt = title
                while len(self.modules) <= i:
                    self.add_module()
                mod = self.modules[i]
                module_prefix = f"模块{i+1}："
                if title.startswith("模块") and "：" in title:
                    title = title.split("：", 1)[-1].strip()
                new_title = f"{module_prefix}{title}"
                mod.widgets['title'].delete(0, tk.END)
                mod.widgets['title'].insert(0, new_title[:60])
                mod.widgets['prompt'].delete("1.0", tk.END)
                mod.widgets['prompt'].insert("1.0", prompt)
                mod.prompt = prompt
            self.reverse_filled_count = len(entries)
            self.status.set(f"已填入 {len(entries) - start_idx} 条新数据到模块")
            messagebox.showinfo("完成", f"已成功将 {len(entries) - start_idx} 条新数据填入模块 {start_idx+1}-{len(entries)}")

        def save_preview_as_template():
            try:
                sel = preview_text.tag_ranges("sel")
                content = preview_text.get(*sel) if sel else preview_text.get("1.0", tk.END).strip()
                if not content: return
                title = simpledialog.askstring("保存为模板", "请输入模板标题：", parent=d)
                if title:
                    self._add_tpl_button(title, content)
                    self.save_templates()
                    self.status.set(f"已添加模板: {title}")
            except Exception as e:
                log_error(f"保存模板失败: {e}")

        def clear_results():
            if messagebox.askyesno("确认清除", "将清空所有反推结果，确定吗？", parent=d):
                preview_text.delete("1.0", tk.END)
                state['reverse_results'] = []
                self.reverse_filled_count = 0
                self.save_reverse_config()
                self.status.set("反推结果已清除")

        def on_preview_right_click(event):
            menu = tk.Menu(d, tearoff=0)
            menu.add_command(label="保存为模板", command=save_preview_as_template)
            menu.add_command(label="清空预览", command=lambda: [preview_text.delete("1.0", tk.END), setattr(self, 'reverse_filled_count', 0)])
            menu.post(event.x_root, event.y_root)

        ttk.Button(btn_frame, text="📋 复制全部", command=copy_all).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="📥 一键填入模块", command=fill_to_modules).pack(side=tk.LEFT, padx=5)
        ttk.Button(btn_frame, text="🧹 清除结果", command=clear_results).pack(side=tk.LEFT, padx=5)

        start_btn = tk.Button(btn_frame, text="🚀 开始反推", command=lambda: start_reverse(),
                              bg="#4CAF50", fg="white", padx=15, font=('Arial',11,'bold'))
        start_btn.pack(side=tk.LEFT, padx=15)

        tk.Label(d, text="9. 精简反推结果：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=20, pady=(5,0))
        preview_frame = tk.Frame(d, height=470, width=720)
        preview_frame.pack(padx=20, pady=5)
        preview_frame.pack_propagate(False)
        preview_text = tk.Text(preview_frame, wrap=tk.WORD, font=('Arial',10), bg='#fafafa', undo=True, maxundo=50)
        preview_text.bind("<Button-3>", on_preview_right_click)
        preview_scroll = ttk.Scrollbar(preview_frame, orient=tk.VERTICAL, command=preview_text.yview)
        preview_text.configure(yscrollcommand=preview_scroll.set)
        preview_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        preview_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        progress_var = tk.StringVar(value="等待开始")
        progress_label = tk.Label(d, textvariable=progress_var, fg='#2980b9')
        progress_label.pack(pady=5)

        if 'reverse_results' in state:
            for title, prompt in state['reverse_results']:
                preview_text.insert(tk.END, f"标题：{title}\n提示词：{prompt}\n\n")

        def start_reverse():
            if not self.reverse_images:
                messagebox.showwarning("提示", "请至少选择一张图片")
                return
            theme = theme_entry.get().strip()
            if not theme:
                messagebox.showwarning("提示", "请输入海报主题")
                return
            cloth_info = cloth_entry.get().strip()
            if not cloth_info:
                messagebox.showwarning("提示", "请输入服装基本信息")
                return
            scene = scene_entry.get().strip()
            gender = gender_var.get()
            font = font_var.get().strip()
            size = size_var.get()
            extra_copy = copy_text.get("1.0", tk.END).strip()
            detail_mode = detail_var.get()

            state['theme'] = theme
            state['cloth_info'] = cloth_info
            state['scene'] = scene
            state['gender'] = gender
            state['font'] = font
            state['font_size'] = size
            state['extra_copy'] = extra_copy
            state['detail_mode'] = detail_mode
            self.save_reverse_config()

            progress_var.set("反推中...")
            start_btn.config(state=tk.DISABLED)
            threading.Thread(target=self._reverse_batch_task,
                             args=(self.reverse_images, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode,
                                   preview_text, progress_var, start_btn),
                             daemon=True).start()

        def on_close():
            content = preview_text.get("1.0", tk.END).strip()
            entries = [e.strip() for e in content.split('\n\n') if e.strip()]
            results = []
            for entry in entries:
                lines = entry.split('\n')
                if len(lines) >= 2:
                    title = lines[0].replace('标题：', '').strip()
                    prompt = '\n'.join(lines[1:]).replace('提示词：', '').strip()
                    if title and prompt:
                        results.append((title, prompt))
            state['reverse_results'] = results
            state['theme'] = theme_entry.get().strip()
            state['cloth_info'] = cloth_entry.get().strip()
            state['scene'] = scene_entry.get().strip()
            state['gender'] = gender_var.get()
            state['font'] = font_var.get().strip()
            state['font_size'] = size_var.get()
            state['extra_copy'] = copy_text.get("1.0", tk.END).strip()
            state['detail_mode'] = detail_var.get()
            state['images'] = self.reverse_images
            self.save_reverse_config()
            d.destroy()
        d.protocol("WM_DELETE_WINDOW", on_close)

    # ---------- 反推批量任务 ----------
    def _reverse_batch_task(self, images, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode,
                            preview_text, progress_var, start_btn):
        total = len(images)
        self.safe_ui(self.status.set, f"正在反推并精简提示词，共 {total} 张图片...")
        refined_count = 0

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = {}
            for idx, img_path in enumerate(images, 1):
                self.safe_ui(progress_var.set, f"提交第 {idx}/{total} 张...")
                future = executor.submit(self._process_one_reverse_with_retry,
                                         img_path, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode, idx, total)
                futures[future] = idx

            for future in as_completed(futures):
                idx = futures[future]
                try:
                    result = future.result(timeout=300)
                    if result:
                        title, prompt = result
                        display_text = f"标题：{title}\n提示词：{prompt}\n\n"
                        self.safe_ui(preview_text.insert, tk.END, display_text)
                        self.safe_ui(preview_text.see, tk.END)
                        refined_count += 1
                    else:
                        log_error(f"反推失败: 图片{idx}/{total}, 返回结果为空")
                except Exception as e:
                    self.safe_ui(preview_text.insert, tk.END, f"--- 图片 {idx} ---\n（反推失败: {str(e)}）\n\n")

        self.safe_ui(progress_var.set, "反推完成")
        self.safe_ui(start_btn.config, {'state': tk.NORMAL})
        self.safe_ui(self.status.set, f"反推完成，共生成 {refined_count} 条带标题的精简提示词")
        if refined_count > 0:
            messagebox.showinfo("完成", f"反推完成，共生成 {refined_count} 条带标题的精简提示词")

    def _process_one_reverse_with_retry(self, img_path, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode, idx, total):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                return self._process_one_reverse(img_path, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode, idx, total)
            except Exception as e:
                log_error(f"图片{idx}/{total} 尝试 {attempt+1}/{max_retries} 失败: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2)
                else:
                    raise

    def _process_one_reverse(self, img_path, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode, idx, total):
        self.safe_ui(self.status.set, f"处理第 {idx}/{total} 张: {os.path.basename(img_path)}")
        raw_prompt = self._call_reverse_api_with_retry(img_path, theme, cloth_info)
        if not raw_prompt:
            raise Exception("反推API无返回")
        refined = self._refine_prompt_with_title_with_retry(raw_prompt, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode)
        if refined:
            return refined
        else:
            raise Exception("精简失败")

    def _call_reverse_api_with_retry(self, img_path, theme, cloth_info, max_retries=3):
        for attempt in range(max_retries):
            result = self._call_reverse_api(img_path, theme, cloth_info)
            if result:
                return result
            if attempt < max_retries - 1:
                time.sleep(2)
        return None

    def _call_reverse_api(self, img_path, theme, cloth_info):
        try:
            img = Image.open(img_path)
            img.thumbnail((1024, 1024), Image.LANCZOS)
            buffered = io.BytesIO()
            img.save(buffered, format="PNG")
            img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
            messages = [
                {"role": "user", "content": [
                    {"type": "text", "text": f"请根据这张参考图，生成一张新的海报提示词。\n主题：{theme}\n服装信息：{cloth_info}\n要求：保留原图的布局、文案内容、字体大小结构、banner标志、场景，但将人物替换为指定的模特（可在后续生成时使用图1作为参考）。请直接输出完整的提示词文本，只输出提示词本身，不要其他解释。"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_base64}"}}
                ]}
            ]
            result = bridge_chat(messages, tier=self.tier, timeout=(10, 180))
            if "choices" in result and result["choices"]:
                msg = result["choices"][0].get("message")
                if msg and "content" in msg:
                    return msg["content"].strip()
            return None
        except Exception as e:
            log_error(f"反推异常: {e}")
            return None

    def _refine_prompt_with_title_with_retry(self, raw_prompt, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode, max_retries=3):
        for attempt in range(max_retries):
            result = self._refine_prompt_with_title(raw_prompt, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode)
            if result:
                return result
            if attempt < max_retries - 1:
                time.sleep(2)
        return None

    def _refine_prompt_with_title(self, raw_prompt, theme, cloth_info, scene, gender, font, size, extra_copy, detail_mode):
        try:
            title_hint = "标题必须为“细节-颜色-材质-平铺/挂拍”格式" if detail_mode else "标题应包含人物数量、主要颜色和款式"
            scene_instruction = f"场景必须严格使用：“{scene}”" if scene else "场景应基于参考图，但可优化为更简洁的棚拍背景。"
            gender_instruction = {
                "女": "所有模特必须为女性，服装为女装。",
                "男": "所有模特必须为男性，服装为男装。",
                "男女款": "可使用男女模特，服装为中性或男女同款。"
            }.get(gender, "所有模特必须为女性，服装为女装。")

            refine_instruction = f"""
你是一位专业的AI绘画提示词工程师。请根据以下原始提示词，生成一个精简、清晰、可直接用于AI绘图的提示词，并提取一个简短标题。

要求：
1. 标题（第一行）：{title_hint}
2. 正文（从第二行开始）：保留原图的海报布局、文案内容、字体层级、banner标志、场景构图。
3. 人物/模特：{"不要生成任何模特或人物" if detail_mode else f"如果原图有人物，则保留人物穿着描述；{gender_instruction}"}
4. 主题为：{theme}，服装信息为：{cloth_info}。
5. 场景要求：{scene_instruction}
6. 主标题字体使用：{font}，主标题字号为：{size}px。
7. 文案补充：{extra_copy if extra_copy else '无'}。
8. 只输出两段：第一段是标题（不带任何前缀），第二段是提示词正文（不带任何前缀）。
9. 提示词正文应清晰描述场景、服装、光线、构图、画质要求，强调实拍真实感。
10. 标题字数控制在4-18字。

原始提示词：
{raw_prompt}

请按格式输出：
[标题]
[提示词正文]
"""
            messages = [{"role": "user", "content": refine_instruction}]
            result = bridge_chat(messages, tier=self.tier, timeout=(10, 120))
            if "choices" in result and result["choices"]:
                content = result["choices"][0]["message"]["content"].strip()
                lines = content.split('\n')
                if len(lines) >= 2:
                    title = lines[0].strip()
                    prompt = '\n'.join(lines[1:]).strip()
                    if len(title) > 18:
                        title = title[:18]
                    elif len(title) < 4:
                        title = f"{theme}海报"
                    return (title, prompt)
                else:
                    return (theme[:18], content)
            return None
        except Exception as e:
            log_error(f"精简异常: {e}")
            return None

    # ---------- 模块创建 ----------
    def create_module_widget(self, mod):
        f = ttk.Frame(self.module_frame, relief=tk.RAISED, borderwidth=1)
        mod.widgets['frame'] = f

        tf = ttk.Frame(f)
        tf.pack(fill=tk.X, padx=3, pady=2)
        title = ttk.Entry(tf, width=20, font=('Arial',10,'bold'))
        title.insert(0, f"模块{mod.index+1}：{'SKU' if mod.is_sku else '创意'}")
        title.pack(side=tk.LEFT, fill=tk.X, expand=True)
        count = ttk.Label(tf, text=f"0/{mod.max_images}", foreground="#2980b9", font=('Arial',9,'bold'))
        count.pack(side=tk.RIGHT, padx=5)
        mod.widgets['title'] = title
        mod.widgets['count'] = count

        if mod.index < 2:
            mode_frame = ttk.Frame(f)
            mode_frame.pack(fill=tk.X, padx=3, pady=2)
            ttk.Label(mode_frame, text="模式:").pack(side=tk.LEFT, padx=2)
            mode_var = tk.StringVar(value="普通")
            mode_combo = ttk.Combobox(mode_frame, textvariable=mode_var, values=["普通", "换装", "换脸"], width=6, state="readonly")
            mode_combo.pack(side=tk.LEFT, padx=2)
            def on_mode_change(*args):
                m = mode_var.get()
                if m == "换装":
                    mod.mode = "hz"
                elif m == "换脸":
                    mod.mode = "hl"
                else:
                    mod.mode = "normal"
            mode_var.trace_add('write', on_mode_change)
            mod.widgets['mode'] = mode_combo

        area = tk.Frame(f, relief=tk.SUNKEN, borderwidth=2, bg='white')
        area.pack(fill=tk.X, padx=3, pady=2, ipady=5)
        cont = tk.Frame(area, bg='white')
        cont.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        mod.thumb_container = cont

        if HAS_DND:
            for widget in (area, cont):
                widget.drop_target_register(DND_FILES)
                widget.dnd_bind('<<Drop>>', lambda e, m=mod: self._on_drop(e, m))

        for widget in (area, cont):
            widget.bind("<Button-1>", lambda e, m=mod: self._pick_images(m))
            widget.bind("<Control-v>", lambda e, m=mod: self._paste_image(m))
            widget.bind("<Button-3>", lambda e, m=mod: self._show_paste_menu(e, m))
            widget.focus_set()

        br = ttk.Frame(f)
        br.pack(fill=tk.X, padx=3, pady=2)
        ttk.Button(br, text="清空图片", width=10, command=lambda: self._clear_images(mod)).pack(side=tk.RIGHT, padx=2)

        ttk.Label(f, text=f"💡 拖拽/粘贴/双击上传图片（最多{mod.max_images}张）", foreground='#888', font=('Arial',8)).pack(fill=tk.X, padx=3)
        self._update_thumbs(mod)

        pf = ttk.Frame(f)
        pf.pack(fill=tk.X, padx=3, pady=2)
        prompt_header = ttk.Frame(pf)
        prompt_header.pack(fill=tk.X, pady=(0,2))
        ttk.Label(prompt_header, text="创意提示词", font=('Arial',9,'bold')).pack(side=tk.LEFT)
        ttk.Button(prompt_header, text="清除关键词", width=10, command=lambda: self._clear_prompt(mod)).pack(side=tk.RIGHT, padx=2)

        prompt_frame = tk.Frame(pf, height=90)
        prompt_frame.pack(fill=tk.X, padx=2, pady=2)
        prompt_frame.pack_propagate(False)
        text = tk.Text(prompt_frame, wrap=tk.WORD, font=('Arial',9), bg='#fafafa', undo=True, maxundo=50)
        text.pack(fill=tk.BOTH, expand=True)
        text.insert("1.0", mod.prompt)
        text.bind('<KeyRelease>', lambda e: setattr(mod, 'prompt', text.get("1.0", tk.END).strip()))
        # 右键菜单增加“GPT改文案”
        def on_prompt_right_click(event):
            menu = tk.Menu(text, tearoff=0)
            try:
                sel = text.tag_ranges("sel")
                if sel:
                    selected_text = text.get(*sel)
                    menu.add_command(label="GPT改文案", command=lambda: self._gpt_edit_prompt(selected_text, text))
                    menu.add_separator()
                    menu.add_command(label="保存选中为模板", command=lambda: self._save_selected_as_template(text))
                else:
                    menu.add_command(label="保存全部为模板", command=lambda: self._save_all_as_template(text))
            except:
                menu.add_command(label="保存全部为模板", command=lambda: self._save_all_as_template(text))
            menu.post(event.x_root, event.y_root)
        text.bind("<Button-3>", on_prompt_right_click)
        mod.widgets['prompt'] = text

        btm = ttk.Frame(pf)
        btm.pack(fill=tk.X, pady=2)
        ttk.Label(btm, text="分辨率：").pack(side=tk.LEFT, padx=2)
        res = ttk.Combobox(btm, values=["1K","2K","4K"], width=4)
        res.set("1K")
        res.pack(side=tk.LEFT, padx=1)
        ttk.Label(btm, text="尺寸：").pack(side=tk.LEFT, padx=2)
        size_var = tk.StringVar(value=mod.size_ratio or "1:1")
        size = ttk.Combobox(btm, textvariable=size_var, values=["1:1","3:4","9:16","2:3"], width=4)
        size.pack(side=tk.LEFT, padx=1)
        mod.widgets['res'] = res
        mod.widgets['size'] = size
        # 下拉选择实时回写 mod.size_ratio，否则 _call_api 永远用默认 1:1（旧 bug）。
        # 注意：trace_add 是 tkinter.Variable 的方法，必须挂在 StringVar 上，不能挂在 Combobox 控件上。
        size_var.trace_add('write', lambda *a: setattr(mod, 'size_ratio', size_var.get()))

        btnf = ttk.Frame(btm)
        btnf.pack(side=tk.RIGHT, padx=2)
        ttk.Button(btnf, text="🚀 提交生成", command=lambda: self.gen_single(mod)).pack(side=tk.LEFT, padx=2)
        ttk.Button(btnf, text="📐 一键主图", command=lambda: self.gen_main(mod)).pack(side=tk.LEFT, padx=2)

        status = ttk.Label(f, text="⚪ 等待", foreground="gray", font=('Arial',8))
        status.pack(fill=tk.X, padx=3, pady=1)
        mod.widgets['status'] = status

        self._bind_scroll_recursive(f)
        return f

    def _gpt_edit_prompt(self, selected_text, text_widget):
        """弹出小窗口修改选中文本，应用后替换"""
        win = tk.Toplevel(self.root)
        win.title("GPT改文案")
        win.geometry("400x300")
        win.transient(self.root)
        ttk.Label(win, text="编辑文本：").pack(pady=5)
        edit_text = tk.Text(win, wrap=tk.WORD, font=('Arial',10))
        edit_text.insert("1.0", selected_text)
        edit_text.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        def apply():
            new_text = edit_text.get("1.0", tk.END).strip()
            if new_text:
                try:
                    sel = text_widget.tag_ranges("sel")
                    text_widget.replace(sel[0], sel[1], new_text)
                except:
                    pass
            win.destroy()
        ttk.Button(win, text="应用", command=apply).pack(pady=5)

    def _save_selected_as_template(self, text_widget):
        try:
            sel = text_widget.tag_ranges("sel")
            if sel:
                content = text_widget.get(*sel)
            else:
                content = text_widget.get("1.0", tk.END).strip()
            if not content:
                return
            title = simpledialog.askstring("保存为模板", "请输入模板标题：")
            if title:
                cat = self.current_category
                if cat not in self.templates:
                    self.templates[cat] = []
                self.templates[cat].append([title, content])
                self.save_templates()
                self._show_category(cat)
                self.status.set(f"已添加模板: {title}")
        except:
            pass

    def _save_all_as_template(self, text_widget):
        content = text_widget.get("1.0", tk.END).strip()
        if not content:
            return
        title = simpledialog.askstring("保存为模板", "请输入模板标题：")
        if title:
            cat = self.current_category
            if cat not in self.templates:
                self.templates[cat] = []
            self.templates[cat].append([title, content])
            self.save_templates()
            self._show_category(cat)
            self.status.set(f"已添加模板: {title}")

    def _clear_prompt(self, mod):
        mod.widgets['prompt'].delete("1.0", tk.END)
        mod.prompt = ""

    def _show_paste_menu(self, event, mod):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="粘贴图片", command=lambda: self._paste_image(mod))
        menu.post(event.x_root, event.y_root)

    # ---------- 图片操作 ----------
    def _on_drop(self, event, mod):
        try:
            data = event.data
            if data.startswith('{') and data.endswith('}'):
                data = data[1:-1]
            for p in data.split():
                p = p.strip()
                if os.path.isfile(p):
                    self._add_image(mod, p)
                    if len(mod.images) >= mod.max_images:
                        break
        except Exception as e:
            log_error(f"拖放失败: {e}")

    def _pick_images(self, mod):
        paths = filedialog.askopenfilenames(filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp")])
        for p in paths:
            self._add_image(mod, p)
            if len(mod.images) >= mod.max_images:
                break

    def _paste_image(self, mod):
        try:
            data = ImageGrab.grabclipboard()
            if data is None:
                return
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, str) and os.path.isfile(item):
                        self._add_image(mod, item)
                        if len(mod.images) >= mod.max_images:
                            break
                return
            if hasattr(data, 'save'):
                temp_dir = Path.cwd() / "temp_paste"
                temp_dir.mkdir(exist_ok=True)
                temp_path = temp_dir / f"paste_{int(time.time())}.png"
                data.save(temp_path)
                self._add_image(mod, str(temp_path))
        except Exception as e:
            log_error(f"粘贴失败: {e}")

    def _add_image(self, mod, path):
        if path in mod.images or len(mod.images) >= mod.max_images:
            return
        mod.images.append(path)
        if mod.save_dir is None:
            mod.save_dir = os.path.dirname(path)
        self._update_thumbs(mod)
        mod.widgets['count'].config(text=f"{len(mod.images)}/{mod.max_images}")
        self.save_state()

    def _clear_images(self, mod):
        mod.images.clear()
        mod.save_dir = None
        mod.generated_filename = None
        mod.generated_image = None
        mod.generated_image_path = None
        self._update_thumbs(mod)
        mod.widgets['count'].config(text=f"0/{mod.max_images}")
        self.save_state()

    def _update_thumbs(self, mod):
        cont = mod.thumb_container
        for w in cont.winfo_children():
            w.destroy()
        for idx, p in enumerate(mod.images):
            try:
                img = Image.open(p)
                img.thumbnail((70,70), Image.LANCZOS)
                photo = ImageTk.PhotoImage(img)
                lbl = tk.Label(cont, image=photo, bg='white', relief=tk.RAISED, borderwidth=1)
                lbl.image = photo
                lbl.pack(side=tk.LEFT, padx=2, pady=2)
                lbl.bind("<Button-1>", lambda e, i=idx: self._remove_image(mod, i))
                lbl.bind("<Button-3>", lambda e, i=idx: self._remove_image(mod, i))
            except:
                lbl = tk.Label(cont, text=f"图{idx+1}\n❌", bg='white')
                lbl.pack(side=tk.LEFT, padx=2, pady=2)
                lbl.bind("<Button-3>", lambda e, i=idx: self._remove_image(mod, i))
        if not mod.images:
            lbl = tk.Label(cont, text=f"📷 拖拽/粘贴/双击上传\n(最多{mod.max_images}张)", bg='white', fg='#888')
            lbl.pack(side=tk.LEFT, padx=10, pady=10)
            lbl.bind("<Button-1>", lambda e: self._pick_images(mod))

    def _remove_image(self, mod, idx):
        if 0 <= idx < len(mod.images):
            mod.images.pop(idx)
            self._update_thumbs(mod)
            mod.widgets['count'].config(text=f"{len(mod.images)}/{mod.max_images}")
            self.save_state()

    # ---------- 模块管理 ----------
    def add_module(self, is_sku=False):
        if len(self.modules) >= self.max_modules:
            messagebox.showwarning("提示", f"最多{self.max_modules}个模块")
            return
        idx = len(self.modules)
        mod = PosterModule(idx, is_sku=is_sku)
        self.create_module_widget(mod)
        self.modules.append(mod)
        self._reflow()
        if len(self.modules) >= self.max_modules:
            self.add_btn.config(state=tk.DISABLED)
        self.status.set(f"模块: {len(self.modules)} 个")
        self.save_state()

    def add_n(self, n):
        for _ in range(min(n, self.max_modules - len(self.modules))):
            self.add_module()

    def add_sku_modules(self, n):
        for _ in range(min(n, self.max_modules - len(self.modules))):
            self.add_module(is_sku=True)

    def remove_module(self):
        if len(self.modules) <= 1:
            messagebox.showinfo("提示", "至少保留1个模块")
            return
        mod = self.modules.pop()
        if 'frame' in mod.widgets:
            mod.widgets['frame'].destroy()
        self._reflow()
        self.add_btn.config(state=tk.NORMAL)
        self.status.set(f"模块: {len(self.modules)} 个")
        self.save_state()

    def _reflow(self):
        children = list(self.module_frame.winfo_children())
        for w in children:
            w.grid_remove()
        cols = 2
        for i, w in enumerate(children):
            w.grid(row=i//cols, column=i%cols, sticky="nsew", padx=4, pady=1)
        self.module_frame.grid_columnconfigure(0, weight=1)
        self.module_frame.grid_columnconfigure(1, weight=1)
        rows = (len(children)+1)//2
        for r in range(rows):
            self.module_frame.grid_rowconfigure(r, weight=1)
        self.outer_frame.update_idletasks()
        self.left_canvas.config(scrollregion=self.left_canvas.bbox("all"))

    # ---------- 模板分类系统 ----------
    def _init_categories(self):
        return [
            "大学生面试", "教资面试", "考公/考编面试", "办公室通勤",
            "职场通勤", "休闲通勤", "商务谈判", "管理类正装",
            "公司会议穿搭", "轻熟商务", "美容/医美/美发", "珠宝",
            "酒店前台", "销售", "大码", "定制"
        ]

    def load_templates(self):
        default_tpls = {
            "职场通勤": [
                ("精工工序细节", "竖版圆角通勤西装精工工序细节详情海报..."),
                ("收腰版型", "竖版圆角通勤西装收腰版型细节详情海报..."),
                ("面料材质", "竖版圆角通勤西装面料材质卖点详情海报..."),
                ("肩线领型", "竖版圆角通勤西装肩线领型双细节详情海报..."),
                ("多场景穿搭", "竖版圆角通勤西装多场景穿搭详情海报...")
            ]
        }
        if os.path.exists(TEMPLATE_FILE):
            try:
                with open(TEMPLATE_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                self.templates = data.get('templates', default_tpls)
                self.categories = data.get('categories_order', self._init_categories())
            except:
                self.templates = default_tpls
                self.categories = self._init_categories()
        else:
            self.templates = default_tpls
            self.categories = self._init_categories()

        if not self.categories and self.templates:
            self.categories = list(self.templates.keys())
        if not self.categories:
            self.categories = self._init_categories()
        if not self.current_category or self.current_category not in self.categories:
            self.current_category = self.categories[0] if self.categories else "默认"
        self._build_category_buttons()
        self._show_category(self.current_category)

    def save_templates(self):
        data = {
            'templates': self.templates,
            'categories_order': self.categories
        }
        try:
            with open(TEMPLATE_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except:
            pass

    def _build_category_buttons(self):
        for w in self.cat_inner.winfo_children():
            w.destroy()
        self.cat_btns.clear()
        for cat in self.categories:
            btn = tk.Button(self.cat_inner, text=cat, relief=tk.RAISED, bg='#e0e0e0',
                            command=lambda c=cat: self._show_category(c))
            btn.pack(side=tk.LEFT, padx=2, pady=2)
            self.cat_btns[cat] = btn
            btn.bind("<Button-3>", lambda e, c=cat: self._edit_category(c))
        tk.Button(self.cat_inner, text="+", command=self._add_category, bg='#c0c0c0').pack(side=tk.LEFT, padx=5, pady=2)
        self.cat_canvas.update_idletasks()
        self.cat_canvas.config(scrollregion=self.cat_canvas.bbox("all"))

    def _show_category(self, cat):
        self.current_category = cat
        for name, btn in self.cat_btns.items():
            btn.config(bg='#a0d2db' if name == cat else '#e0e0e0')
        for w in self.tpl_inner.winfo_children():
            w.destroy()
        if cat in self.templates:
            templates = self.templates[cat]
            row_frame = None
            col_count = 0
            for i, (title, content) in enumerate(templates):
                if col_count % 7 == 0:
                    row_frame = tk.Frame(self.tpl_inner, bg='#f0f2f5')
                    row_frame.pack(fill=tk.X, pady=2)
                    col_count = 0
                btn = tk.Button(row_frame, text=title, font=('Arial',9), bg='#e3f2fd', fg='#1565c0',
                                relief=tk.RAISED, padx=8, pady=3, wraplength=120,
                                command=lambda c=content: self._apply_tpl(c))
                btn._content = content
                btn.pack(side=tk.LEFT, padx=3, pady=3)
                btn.bind("<Button-3>", lambda e, t=title, c=content, b=btn: self._show_tpl_menu(e, b, t, c))
                col_count += 1
        self.tpl_inner.update_idletasks()
        self.tpl_canvas.config(scrollregion=self.tpl_canvas.bbox("all"))

    def _add_category(self):
        name = simpledialog.askstring("新分类", "分类名称:")
        if name and name not in self.categories:
            self.categories.append(name)
            self.templates[name] = []
            self._build_category_buttons()
            self._show_category(name)
            self.save_templates()

    def _edit_category(self, old_name):
        new_name = simpledialog.askstring("重命名", "新名称:", initialvalue=old_name)
        if new_name and new_name != old_name and new_name not in self.categories:
            idx = self.categories.index(old_name)
            self.categories[idx] = new_name
            self.templates[new_name] = self.templates.pop(old_name)
            self._build_category_buttons()
            if self.current_category == old_name:
                self.current_category = new_name
            self._show_category(new_name)
            self.save_templates()

    def batch_import_templates(self):
        dialog = tk.Toplevel(self.root)
        dialog.title("批量导入模板")
        dialog.geometry("600x500")
        dialog.transient(self.root)
        ttk.Label(dialog, text="粘贴文本（标题一行，内容多行，用空行分隔不同模板）").pack(pady=5)
        text = tk.Text(dialog, wrap=tk.WORD, height=15)
        text.pack(fill=tk.BOTH, expand=True, padx=10)
        ttk.Label(dialog, text="选择分类:").pack()
        cat_var = tk.StringVar(value=self.current_category)
        cat_combo = ttk.Combobox(dialog, textvariable=cat_var, values=self.categories)
        cat_combo.pack()
        def do_import():
            raw = text.get("1.0", tk.END).strip()
            blocks = [b.strip() for b in raw.split('\n\n') if b.strip()]
            added = 0
            for block in blocks:
                lines = block.split('\n')
                if not lines:
                    continue
                title = lines[0].strip()
                content = '\n'.join(lines[1:]).strip()
                if title and content:
                    cat = cat_var.get()
                    if cat not in self.templates:
                        self.templates[cat] = []
                    self.templates[cat].append([title, content])
                    added += 1
            self.save_templates()
            self._show_category(cat_var.get())
            self.status.set(f"批量导入 {added} 条模板")
            dialog.destroy()
        ttk.Button(dialog, text="导入", command=do_import).pack(pady=10)

    def _show_tpl_menu(self, event, btn, title, content):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="编辑", command=lambda: self._edit_tpl(btn, title, content))
        menu.add_command(label="删除", command=lambda: self._delete_tpl(btn))
        menu.add_separator()
        menu.add_command(label="复制内容", command=lambda: self.root.clipboard_append(content))
        menu.add_command(label="导出此模板", command=lambda: self._export_single_template(title, content))
        menu.post(event.x_root, event.y_root)

    def _export_single_template(self, title, content):
        path = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("JSON","*.json")])
        if path:
            try:
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump({"title": title, "content": content}, f, ensure_ascii=False)
                self.status.set(f"模板已导出: {os.path.basename(path)}")
            except Exception as e:
                messagebox.showerror("错误", f"导出失败: {e}")

    def _delete_tpl(self, btn):
        if messagebox.askyesno("确认", "删除模板？"):
            cat = self.current_category
            content = btn._content
            self.templates[cat] = [t for t in self.templates[cat] if t[1] != content]
            self.save_templates()
            self._show_category(cat)
            self.status.set("模板已删除")

    def _edit_tpl(self, btn, old_title, old_content):
        dialog = tk.Toplevel(self.root)
        dialog.title("编辑模板")
        dialog.geometry("500x300")
        dialog.transient(self.root)
        ttk.Label(dialog, text="标题:").pack(pady=(10,5), padx=20, anchor=tk.W)
        title_entry = ttk.Entry(dialog, width=50)
        title_entry.insert(0, old_title)
        title_entry.pack(padx=20, fill=tk.X)
        ttk.Label(dialog, text="内容:").pack(pady=(10,5), padx=20, anchor=tk.W)
        content_text = tk.Text(dialog, height=6)
        content_text.insert("1.0", old_content)
        content_text.pack(padx=20, fill=tk.BOTH, expand=True)
        def save():
            new_title = title_entry.get().strip()
            new_content = content_text.get("1.0", tk.END).strip()
            if new_title and new_content:
                cat = self.current_category
                new_list = []
                for t, c in self.templates[cat]:
                    if c == old_content:
                        new_list.append([new_title, new_content])
                    else:
                        new_list.append([t, c])
                self.templates[cat] = new_list
                self.save_templates()
                dialog.destroy()
                self._show_category(cat)
                self.status.set(f"模板已更新: {new_title}")
            else:
                messagebox.showwarning("提示", "标题和内容不能为空")
        ttk.Button(dialog, text="保存", command=save).pack(pady=10)
        ttk.Button(dialog, text="取消", command=dialog.destroy).pack(pady=5)

    def add_tpl(self):
        dialog = tk.Toplevel(self.root)
        dialog.title("添加提示词模块")
        dialog.geometry("500x350")
        dialog.transient(self.root)
        tk.Label(dialog, text="标题：").pack(pady=(10,0), padx=20, anchor=tk.W)
        title_entry = tk.Entry(dialog, width=50)
        title_entry.pack(padx=20, fill=tk.X)
        tk.Label(dialog, text="选择分类：").pack(pady=(10,0), padx=20, anchor=tk.W)
        cat_var = tk.StringVar(value=self.current_category)
        cat_combo = ttk.Combobox(dialog, textvariable=cat_var, values=self.categories)
        cat_combo.pack(padx=20, fill=tk.X)
        tk.Label(dialog, text="内容：").pack(pady=(10,0), padx=20, anchor=tk.W)
        content_text = tk.Text(dialog, height=10, wrap=tk.WORD)
        content_text.pack(padx=20, fill=tk.BOTH, expand=True)
        btn_frame = tk.Frame(dialog)
        btn_frame.pack(pady=10)
        def on_ok():
            title = title_entry.get().strip()
            content = content_text.get("1.0", tk.END).strip()
            if not title or not content:
                messagebox.showwarning("提示", "标题和内容不能为空")
                return
            cat = cat_var.get()
            if cat not in self.templates:
                self.templates[cat] = []
            self.templates[cat].append([title, content])
            self.save_templates()
            if cat == self.current_category:
                self._show_category(cat)
            dialog.destroy()
            self.status.set(f"已添加模板: {title}")
        tk.Button(btn_frame, text="确定", command=on_ok, width=10, bg="#4CAF50", fg="white").pack(side=tk.LEFT, padx=10)
        tk.Button(btn_frame, text="取消", command=dialog.destroy, width=10).pack(side=tk.LEFT, padx=10)

    def _apply_tpl(self, content):
        focus_widget = self.root.focus_get()
        for mod in self.modules:
            if mod.widgets.get('prompt') == focus_widget:
                text = focus_widget
                try:
                    text.insert(tk.INSERT, content)
                except:
                    text.insert("1.0", content)
                mod.prompt = text.get("1.0", tk.END).strip()
                self.status.set(f"已插入模板到模块{mod.index+1}")
                return
        for mod in self.modules:
            if not mod.prompt:
                text = mod.widgets['prompt']
                text.insert("1.0", content)
                mod.prompt = text.get("1.0", tk.END).strip()
                self.status.set(f"已插入模板到模块{mod.index+1}")
                return
        if self.modules:
            mod = self.modules[-1]
            text = mod.widgets['prompt']
            text.insert(tk.END, content)
            mod.prompt = text.get("1.0", tk.END).strip()
            self.status.set(f"已插入模板到模块{mod.index+1}")

    # ---------- API 生成 ----------
    def gen_single(self, mod):
        if not mod.prompt and mod.mode == "normal":
            messagebox.showwarning("提示", "请输入关键词")
            return
        if mod.mode in ("hz", "hl") and mod.images:
            threading.Thread(target=self._gen_mode_batch, args=(mod,), daemon=True).start()
        else:
            threading.Thread(target=self._gen_task, args=(mod,), daemon=True).start()

    def _gen_mode_batch(self, mod):
        if len(mod.images) < 2:
            messagebox.showwarning("提示", "需要至少两张图片（参考图+至少一张目标图）")
            return
        source_img = mod.images[0]
        target_imgs = mod.images[1:]
        total = len(target_imgs)
        base_dir = self.main_images_dir or os.path.dirname(source_img)
        os.makedirs(base_dir, exist_ok=True)

        prefix = "HZ" if mod.mode == "hz" else "HL"
        count = 0
        for idx, target in enumerate(target_imgs):
            if self.stop_gen:
                break
            self.safe_ui(self._set_status, mod, f"⏳ {mod.mode} {idx+1}/{total}", "#2980b9")
            if mod.mode == "hz":
                prompt = f"换装：将图1（{os.path.basename(source_img)}）的衣服换到图{idx+2}（{os.path.basename(target)}）的模特身上。{mod.prompt}"
            else:
                prompt = f"换脸：将图1（{os.path.basename(source_img)}）的脸换到图{idx+2}（{os.path.basename(target)}）的模特身上。{mod.prompt}"

            old_prompt = mod.prompt
            mod.prompt = prompt
            img_path = self._call_api(mod, target_size=RATIO_STANDARD_SIZE["1:1"], ratio="1:1")
            mod.prompt = old_prompt

            if img_path and os.path.exists(img_path):
                count += 1
                new_name = f"{prefix}_{count:06d}.png"
                new_path = os.path.join(base_dir, new_name)
                idx_temp = 1
                while os.path.exists(new_path):
                    new_name = f"{prefix}_{count:06d}_{idx_temp:02d}.png"
                    new_path = os.path.join(base_dir, new_name)
                    idx_temp += 1
                shutil.move(img_path, new_path)
                if idx == total - 1:
                    mod.generated_image = Image.open(new_path)
                    mod.generated_image_path = new_path
                    self.safe_ui(self._set_status, mod, f"✅ 完成 {total}张", "#27ae60")
                self.safe_ui(self.switch_preview)
            else:
                self.safe_ui(self._set_status, mod, f"❌ {idx+1}失败", "#e74c3c")

            if idx < total - 1:
                self.safe_ui(self.status.set, f"等待8秒后继续...")
                time.sleep(8)

        self.save_state()

    def _gen_task(self, mod, retry_count=0, max_retries=15, wait_seconds=90):
        try:
            self.safe_ui(self._set_status, mod, "⏳ 生成中", "#2980b9")
            img_path = self._call_api(mod)
            if img_path and os.path.exists(img_path):
                try:
                    img = Image.open(img_path)
                    img.verify()
                    img = Image.open(img_path)
                    mod.generated_image = img
                    mod.generated_image_path = img_path
                    self.safe_ui(self._set_status, mod, "✅ 成功", "#27ae60")
                    self.safe_ui(self.switch_preview)
                    self.save_state()
                    return
                except Exception as e:
                    try:
                        os.remove(img_path)
                    except:
                        pass
            if retry_count < max_retries:
                time.sleep(wait_seconds)
                self._gen_task(mod, retry_count+1, max_retries, wait_seconds)
            else:
                self.safe_ui(self._set_status, mod, "❌ 失败", "#e74c3c")
        except Exception as e:
            self.safe_ui(self._set_status, mod, "❌ 错误", "#e74c3c")

    def _call_api(self, mod, target_size=None, custom_name=None, ratio=None):
        try:
            if ratio is None:
                ratio = mod.size_ratio
            # target_size（标准 size 字符串）优先；否则按 ratio 查标准 size。
            # 不再用 1254x1254 这类自定义像素值——上游不认会被忽略/报错。
            size_str = target_size if target_size else RATIO_STANDARD_SIZE.get(ratio, "1024x1024")

            if not mod.images:
                raise Exception("无图片")

            if self.global_save_dir:
                save_dir = self.global_save_dir
            elif mod.save_dir is not None:
                save_dir = mod.save_dir
            else:
                save_dir = str(Path.cwd() / "image")
            Path(save_dir).mkdir(parents=True, exist_ok=True)

            # 经平台桥 /image/edit（首张参考图 + prompt），返回 data:URI 或 URL 列表。
            # 原脚本仅用 mod.images[0] 作参考图；发多张会触发上游多图不稳定，保持单图。
            images_out = bridge_image_edit(mod.prompt, [mod.images[0]], tier=self.tier, n=1, size=size_str, timeout=(10, 180))
            if not images_out:
                return None

            image_data = None
            for src in images_out:
                try:
                    image_data = fetch_image_bytes(src)
                    if image_data:
                        break
                except Exception as e:
                    log_error(f"下载结果图失败: {e}")
            if image_data is None:
                return None

            # 上游返回图按目标比例 center-crop 到精确像素（上游可能不认 size，客户端兜底保证比例）。
            try:
                pil = Image.open(io.BytesIO(image_data))
                pil = _crop_to_ratio(pil, ratio)
                buf = io.BytesIO()
                pil.save(buf, format="PNG")
                image_data = buf.getvalue()
            except Exception as e:
                log_error(f"结果图裁剪失败(原样保留): {e}")

            if custom_name:
                base_name = custom_name
            else:
                prefix = "SKU" if mod.is_sku else "CH"
                base_name = f"{prefix}{mod.index+1:02d}_{int(time.time()*1000)}_{random.randint(1000,9999)}"

            candidate = Path(save_dir) / f"{base_name}.png"
            if candidate.exists():
                idx = 1
                while True:
                    candidate = Path(save_dir) / f"{base_name}_{idx:02d}.png"
                    if not candidate.exists():
                        break
                    idx += 1

            with open(candidate, 'wb') as f:
                f.write(image_data)

            try:
                Image.open(candidate).verify()
                mod.generated_filename = candidate.name
                mod.generated_image_path = str(candidate)
                return str(candidate)
            except:
                os.remove(candidate)
                return None

        except Exception as e:
            log_error(f"API调用异常: {e}")
            return None

    def _set_status(self, mod, text, color):
        mod.status = text
        mod.widgets['status'].config(text=text, foreground=color)

    # ---------- 一键主图 ----------
    def gen_main(self, mod):
        if not mod.prompt:
            messagebox.showwarning("提示", "请输入关键词")
            return
        if getattr(mod, '_main_generating', False):
            messagebox.showinfo("提示", "正在生成中")
            return
        threading.Thread(target=self._gen_main_task, args=(mod,), daemon=True).start()

    def _gen_main_task(self, mod):
        try:
            mod._main_generating = True
            if self.main_images_dir is None:
                base_dir = os.path.join(os.path.dirname(mod.images[0]) if mod.images else os.getcwd(), "主图")
                os.makedirs(base_dir, exist_ok=True)
                self.main_images_dir = base_dir
            else:
                base_dir = self.main_images_dir
                if not os.path.exists(base_dir):
                    os.makedirs(base_dir, exist_ok=True)

            size_configs = [("1:1", "1440"), ("3:4", "1920"), ("2:3", "2160")]
            success_count = 0
            last_img = None
            last_path = None

            for ratio, prefix in size_configs:
                existing = [f for f in os.listdir(base_dir) if f.startswith(f"{prefix}-") and f.endswith(".png")]
                max_num = 0
                for f in existing:
                    try:
                        num = int(f.replace(f"{prefix}-", "").replace(".png", ""))
                        max_num = max(max_num, num)
                    except:
                        pass
                filename = f"{prefix}-{max_num+1}.png"

                mod.size_ratio = ratio
                self.safe_ui(self._set_status, mod, f"⏳ 生成{ratio}", "#2980b9")
                target_size = RATIO_STANDARD_SIZE.get(ratio, "1024x1024")
                old_save_dir = mod.save_dir
                mod.save_dir = base_dir
                img_path = self._call_api(mod, target_size=target_size, ratio=ratio, custom_name=filename.replace(".png", ""))
                mod.save_dir = old_save_dir

                if img_path and os.path.exists(img_path):
                    try:
                        img = Image.open(img_path)
                        img.verify()
                        img = Image.open(img_path)
                        success_count += 1
                        last_img = img
                        last_path = img_path
                        self.safe_ui(self._set_status, mod, f"✅ {ratio}成功", "#27ae60")
                    except:
                        try: os.remove(img_path)
                        except: pass
                else:
                    self.safe_ui(self._set_status, mod, f"❌ {ratio}失败", "#e74c3c")

                time.sleep(2)

            mod.size_ratio = "1:1"
            if last_img:
                mod.generated_image = last_img
                mod.generated_image_path = last_path
                self.safe_ui(self._set_status, mod, f"✅ 成功({success_count}/3)", "#27ae60")
                self.safe_ui(self.switch_preview)
            else:
                self.safe_ui(self._set_status, mod, "❌ 全部失败", "#e74c3c")
            self.save_state()
        except Exception as e:
            self.safe_ui(self._set_status, mod, "❌ 错误", "#e74c3c")
        finally:
            mod._main_generating = False

    # ---------- 批量生成 ----------
    def gen_all(self):
        if self.is_generating:
            return
        active = [m for m in self.modules if m.prompt]
        if not active:
            messagebox.showwarning("提示", "没有可生成的模块")
            return
        self.is_generating = True
        self.stop_gen = False
        threading.Thread(target=self._gen_all_task, daemon=True).start()

    def _gen_all_task(self):
        total = len([m for m in self.modules if m.prompt])
        done = 0
        self.safe_ui(self.prog_label.config, text=f"0/{total}")
        for mod in self.modules:
            if self.stop_gen or not mod.prompt:
                continue
            self._gen_task(mod)
            done += 1
            self.safe_ui(self.progress.set, int(done/total*100))
            self.safe_ui(self.prog_label.config, text=f"{done}/{total}")
            if done < total:
                for _ in range(180):
                    if self.stop_gen:
                        break
                    time.sleep(0.5)
        self.is_generating = False
        self.safe_ui(self.prog_label.config, text="")
        self.safe_ui(self.status.set, f"生成完成 {done}/{total}")

    # ---------- 预览功能 ----------
    def switch_preview(self):
        mode = self.preview_mode.get()
        self.preview_zoom = 1.0
        if mode == "整体预览":
            self._show_overall()
            self.save_long_btn.pack(side=tk.BOTTOM, pady=5)
        elif mode == "分开预览":
            self._show_split()
            self.save_long_btn.pack_forget()
        else:
            self._show_main_preview()
            self.save_long_btn.pack_forget()

    def _show_overall(self):
        valid_imgs = []
        for mod in self.modules:
            if mod.generated_image_path and os.path.exists(mod.generated_image_path):
                try:
                    img = Image.open(mod.generated_image_path)
                    img.verify()
                    img = Image.open(mod.generated_image_path)
                    valid_imgs.append(img)
                except:
                    pass
        if not valid_imgs:
            self.preview_canvas.delete("all")
            self.preview_canvas.create_text(400,300, text="暂无可用图片", font=('Arial',20), fill='gray')
            self.current_preview_image = None
            return
        target_w = 400
        resized = []
        for img in valid_imgs:
            ratio = target_w / img.width
            new = img.copy()
            new.thumbnail((target_w, int(img.height*ratio)), Image.LANCZOS)
            resized.append(new)
        total_h = sum(i.height for i in resized) + 10*(len(resized)-1)
        canvas = Image.new('RGB', (target_w, total_h), (255,255,255))
        y = 0
        for img in resized:
            canvas.paste(img, ((target_w-img.width)//2, y))
            y += img.height + 10
        self.current_preview_image = canvas
        self._display_preview_centered(canvas)

    def _display_preview_centered(self, img):
        canvas_w = self.preview_canvas.winfo_width()
        canvas_h = self.preview_canvas.winfo_height()
        if canvas_w <= 1: canvas_w = 600
        if canvas_h <= 1: canvas_h = 800

        if self.preview_fit_mode == "fit":
            zoom = self.preview_zoom
            base_scale = min(canvas_w/img.width, canvas_h/img.height, 1.0)
            scale = base_scale * zoom
            new_w = int(img.width * scale)
            new_h = int(img.height * scale)
            if new_w < 1: new_w = 1
            if new_h < 1: new_h = 1
            if scale != 1.0:
                resized = img.resize((new_w, new_h), Image.LANCZOS)
            else:
                resized = img.copy()
            photo = ImageTk.PhotoImage(resized)
            self._preview_photo = photo
            self.preview_canvas.delete("all")
            x = (canvas_w - new_w) // 2
            y = (canvas_h - new_h) // 2
            self.preview_canvas.create_image(x, y, image=photo, anchor='nw')
            self.preview_canvas.config(scrollregion=(0,0,new_w,new_h))
        else:
            photo = ImageTk.PhotoImage(img)
            self._preview_photo = photo
            self.preview_canvas.delete("all")
            x = (canvas_w - img.width) // 2 if img.width < canvas_w else 0
            y = (canvas_h - img.height) // 2 if img.height < canvas_h else 0
            self.preview_canvas.create_image(x, y, image=photo, anchor='nw')
            self.preview_canvas.config(scrollregion=(0,0,img.width,img.height))

    def _show_split(self):
        self.preview_canvas.delete("all")
        self.current_preview_items = []
        for mod in self.modules:
            if mod.generated_image_path and os.path.exists(mod.generated_image_path):
                try:
                    img = Image.open(mod.generated_image_path)
                    img.verify()
                    img = Image.open(mod.generated_image_path)
                    self.current_preview_items.append({
                        'module_index': mod.index,
                        'title': f"模块{mod.index+1}",
                        'image': img.copy().resize((300, int(300/img.width*img.height))),
                        'original': img,
                        'path': mod.generated_image_path,
                        'y': 0,
                        'height': 0
                    })
                except:
                    pass
        if not self.current_preview_items:
            self.preview_canvas.create_text(400,300, text="暂无可用图片", font=('Arial',20), fill='gray')
            return
        spacing = 20
        y = 10
        for item in self.current_preview_items:
            item['y'] = y
            item['height'] = item['image'].height + 30
            y += item['height'] + spacing
        self._display_split_preview()

    def _display_split_preview(self):
        self.preview_canvas.delete("all")
        canvas_w = self.preview_canvas.winfo_width()
        if canvas_w <= 1: canvas_w = 600
        for item in self.current_preview_items:
            x = (canvas_w - item['image'].width)//2
            self.preview_canvas.create_text(x + item['image'].width//2, item['y'], text=item['title'], anchor='n', font=('Arial',10,'bold'))
            photo = ImageTk.PhotoImage(item['image'])
            self._preview_photos.append(photo)
            img_id = self.preview_canvas.create_image(x, item['y']+20, image=photo, anchor='nw')
            self.preview_canvas.tag_bind(img_id, "<Double-Button-1>", lambda e, p=item['path']: self._show_viewer(Image.open(p)))
            self.preview_canvas.tag_bind(img_id, "<Button-3>", lambda e, p=item['path']: self._show_split_preview_menu(e, p))
        total_h = sum(item['height'] for item in self.current_preview_items) + 20
        self.preview_canvas.config(scrollregion=(0,0,canvas_w, total_h))

    def _show_split_preview_menu(self, event, img_path):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="2K/4K高清修复", command=lambda: self._upscale_single_path(img_path))
        menu.add_command(label="PS修图", command=lambda: self._open_in_ps(img_path))
        menu.post(event.x_root, event.y_root)

    # ---------- 主图预览（保持比例缩略图，支持拖拽到模块/GPT，支持重命名） ----------
    def _show_main_preview(self):
        preview_files = []
        if self.main_images_dir and os.path.exists(self.main_images_dir):
            for f in os.listdir(self.main_images_dir):
                if f.lower().endswith(('.png', '.jpg', '.jpeg')):
                    preview_files.append(os.path.join(self.main_images_dir, f))
        for mod in self.modules:
            if mod.generated_image_path and ("HZ_" in mod.generated_image_path or "HL_" in mod.generated_image_path):
                if mod.generated_image_path not in preview_files:
                    preview_files.append(mod.generated_image_path)

        if not preview_files:
            self.preview_canvas.delete("all")
            self.preview_canvas.create_text(400,300, text="暂无主图", font=('Arial',20), fill='gray')
            return

        thumb_width = 145
        spacing = 10
        canvas_w = self.preview_canvas.winfo_width()
        if canvas_w <= 1: canvas_w = 600
        cols = max(3, min(10, (canvas_w - spacing) // (thumb_width + spacing)))
        if cols < 3: cols = 3

        items = []
        for fpath in preview_files:
            try:
                img = Image.open(fpath)
                w, h = img.size
                ratio = thumb_width / w
                thumb_h = int(h * ratio)
                if thumb_h < 20: thumb_h = 20
                thumb = img.resize((thumb_width, thumb_h), Image.LANCZOS)
                items.append({
                    'filename': os.path.basename(fpath),
                    'path': fpath,
                    'image': thumb,
                    'original': img,
                    'width': thumb_width,
                    'height': thumb_h
                })
            except:
                continue

        if not items:
            self.preview_canvas.delete("all")
            self.preview_canvas.create_text(400,300, text="图片加载失败", font=('Arial',20), fill='gray')
            return

        rows = []
        row_items = []
        max_h = 0
        for i, item in enumerate(items):
            row_items.append(item)
            if item['height'] > max_h:
                max_h = item['height']
            if (i+1) % cols == 0 or i == len(items)-1:
                rows.append((row_items, max_h))
                row_items = []
                max_h = 0
        if row_items:
            rows.append((row_items, max_h))

        self.main_preview_items = items

        self.preview_canvas.delete("all")
        y = spacing
        for row_items, row_height in rows:
            x = spacing
            for item in row_items:
                y_offset = (row_height - item['height']) // 2
                photo = ImageTk.PhotoImage(item['image'])
                self._preview_photos.append(photo)
                img_id = self.preview_canvas.create_image(x, y + y_offset, image=photo, anchor='nw')
                self.preview_canvas.tag_bind(img_id, "<Double-Button-1>", lambda e, p=item['path']: self._show_viewer(Image.open(p)))
                self.preview_canvas.tag_bind(img_id, "<Button-3>", lambda e, p=item['path'], fname=item['filename']: self._show_main_preview_menu(e, p, fname))
                self.preview_canvas.tag_bind(img_id, "<ButtonPress-1>", lambda e, p=item['path']: self._start_drag_preview(e, p))
                self.preview_canvas.tag_bind(img_id, "<B1-Motion>", self._drag_preview_motion)
                self.preview_canvas.tag_bind(img_id, "<ButtonRelease-1>", self._end_drag_preview)
                fname = item['filename']
                if len(fname) > 20:
                    fname = fname[:17] + '...'
                self.preview_canvas.create_text(x + thumb_width//2, y + row_height + 12, text=fname, font=('Arial',8), fill='#333')
                x += thumb_width + spacing
            y += row_height + 25 + spacing

        total_h = y
        self.preview_canvas.config(scrollregion=(0, 0, canvas_w, total_h))

    def _start_drag_preview(self, event, path):
        self.drag_data = path
        self.drag_from_preview = True

    def _drag_preview_motion(self, event):
        pass

    def _end_drag_preview(self, event):
        if not self.drag_data or not self.drag_from_preview:
            return
        path = self.drag_data
        self.drag_from_preview = False
        widget = self.root.winfo_containing(event.x_root, event.y_root)
        if widget is None:
            if messagebox.askyesno("保存图片", f"是否保存 {os.path.basename(path)} 到指定位置？"):
                save_path = filedialog.asksaveasfilename(defaultextension=".png", filetypes=[("PNG","*.png")])
                if save_path:
                    shutil.copy(path, save_path)
                    self.status.set(f"已保存到: {save_path}")
            self.drag_data = None
            return

        for mod in self.modules:
            container = mod.thumb_container
            w = widget
            while w is not None:
                if w == container:
                    self._add_image(mod, path)
                    self.drag_data = None
                    return
                w = w.master
        if self.gpt55_win is not None and self.gpt55_win.winfo_exists():
            try:
                if widget.winfo_toplevel() == self.gpt55_win:
                    self._gpt55_add_image(path)
                    self.drag_data = None
                    return
            except:
                pass
        if messagebox.askyesno("保存图片", f"是否保存 {os.path.basename(path)} 到指定位置？"):
            save_path = filedialog.asksaveasfilename(defaultextension=".png", filetypes=[("PNG","*.png")])
            if save_path:
                shutil.copy(path, save_path)
                self.status.set(f"已保存到: {save_path}")
        self.drag_data = None

    def _show_main_preview_menu(self, event, img_path, filename):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="PS修图", command=lambda: self._open_in_ps(img_path))
        menu.add_command(label="打开文件夹", command=lambda: self._open_folder(img_path))
        menu.add_command(label="删除", command=lambda: self._delete_main_image(img_path))
        menu.add_command(label="重命名", command=lambda: self._rename_main_image(img_path, filename))
        menu.post(event.x_root, event.y_root)

    def _rename_main_image(self, old_path, old_name):
        new_name = simpledialog.askstring("重命名图片", "新名称（不含扩展名）:", initialvalue=os.path.splitext(old_name)[0])
        if new_name:
            ext = os.path.splitext(old_name)[1]
            new_filename = new_name + ext
            new_path = os.path.join(os.path.dirname(old_path), new_filename)
            try:
                os.rename(old_path, new_path)
                self.status.set(f"已重命名: {new_filename}")
                self.switch_preview()
            except Exception as e:
                messagebox.showerror("错误", f"重命名失败: {e}")

    def _open_folder(self, img_path):
        folder = os.path.dirname(img_path)
        if sys.platform == 'win32':
            os.startfile(folder)
        else:
            subprocess.Popen(['open', folder])

    def _delete_main_image(self, img_path):
        if messagebox.askyesno("确认删除", f"删除 {os.path.basename(img_path)}？"):
            try:
                os.remove(img_path)
                self.status.set(f"已删除: {os.path.basename(img_path)}")
                self.switch_preview()
            except Exception as e:
                messagebox.showerror("错误", f"删除失败: {e}")

    def _upscale_single_path(self, img_path):
        if img_path and os.path.exists(img_path):
            threading.Thread(target=self._upscale_task, args=([img_path], 3840, True), daemon=True).start()

    def _open_in_ps(self, img_path):
        if not self.ps_path or not os.path.exists(self.ps_path):
            self.set_ps()
        if self.ps_path and os.path.exists(self.ps_path) and img_path:
            try:
                subprocess.Popen([self.ps_path, img_path])
            except Exception as e:
                messagebox.showerror("错误", f"无法启动PS: {e}")

    def set_ps(self):
        p = filedialog.askopenfilename(title="选择Photoshop.exe", filetypes=[("Exe","*.exe")])
        if p:
            self.ps_path = p
            self.save_reverse_config()
        else:
            for p in ["C:/Program Files/Adobe/Adobe Photoshop 2024/Photoshop.exe",
                      "C:/Program Files/Adobe/Adobe Photoshop 2023/Photoshop.exe",
                      "C:/Program Files/Adobe/Adobe Photoshop 2022/Photoshop.exe"]:
                if os.path.exists(p):
                    self.ps_path = p
                    self.save_reverse_config()
                    break

    def _show_viewer(self, img):
        viewer = tk.Toplevel(self.root)
        viewer.title("大图预览")
        w, h = img.size
        max_w, max_h = 1200, 900
        scale = min(max_w/w, max_h/h, 1.0)
        display = img.copy()
        display.thumbnail((int(w*scale), int(h*scale)), Image.LANCZOS)
        viewer.geometry(f"{display.width+20}x{display.height+40}")
        canvas = tk.Canvas(viewer, bg='white')
        canvas.pack(fill=tk.BOTH, expand=True)
        photo = ImageTk.PhotoImage(display)
        canvas.create_image(display.width//2, display.height//2, image=photo, anchor='center')
        viewer.photo = photo
        canvas.bind("<Double-Button-1>", lambda e: viewer.destroy())

    def _on_preview_ctrl_scroll(self, event):
        pass

    def _update_zoomed_preview(self):
        pass

    def _on_preview_scroll(self, event):
        self.preview_canvas.yview_scroll(int(-1*(event.delta/120)), "units")

    def _on_preview_double(self, event):
        pass

    # ---------- 拼长图等 ----------
    def merge_long(self):
        imgs = []
        for mod in self.modules:
            if mod.generated_image_path and os.path.exists(mod.generated_image_path):
                try:
                    img = Image.open(mod.generated_image_path)
                    img.verify()
                    img = Image.open(mod.generated_image_path)
                    imgs.append(img)
                except:
                    continue
        if not imgs:
            messagebox.showwarning("提示", "没有可用的图片")
            return
        max_w = max(i.width for i in imgs)
        total_h = sum(i.height for i in imgs) + 20*(len(imgs)-1)
        long = Image.new('RGB', (max_w, total_h), (255,255,255))
        y = 0
        for img in imgs:
            x = (max_w - img.width)//2
            long.paste(img, (x, y))
            y += img.height + 20
        self.long_image = long
        self.current_preview_image = long
        self._display_preview_centered(long)
        self.save_long_btn.pack(side=tk.BOTTOM, pady=5)
        self.status.set(f"长图已生成，共{len(imgs)}张")

    def save_long(self):
        if hasattr(self, 'long_image') and self.long_image:
            path = filedialog.asksaveasfilename(defaultextension=".png", filetypes=[("PNG","*.png")])
            if path:
                self.long_image.save(path)

    def save_detail(self):
        prefix = simpledialog.askstring("详情页命名", "前缀", initialvalue="详情页")
        if not prefix: return
        folder = filedialog.askdirectory()
        if not folder: return
        idx = 1
        for mod in self.modules:
            if mod.generated_image:
                path = os.path.join(folder, f"{prefix}{idx:02d}.png")
                mod.generated_image.save(path)
                idx += 1
        self.status.set(f"详情页已保存 {idx-1} 张")

    def clear_all(self):
        if messagebox.askyesno("确认", "清空所有模块？"):
            for mod in self.modules:
                mod.images.clear()
                mod.save_dir = None
                mod.generated_filename = None
                mod.generated_image = None
                mod.generated_image_path = None
                mod.widgets['prompt'].delete("1.0", tk.END)
                mod.prompt = ""
                self._update_thumbs(mod)
                mod.widgets['count'].config(text=f"0/{mod.max_images}")
                self._set_status(mod, "⚪ 等待", "gray")
            self.preview_canvas.delete("all")
            self.long_image = None
            self.save_long_btn.pack_forget()
            self.save_state()

    # ---------- 状态持久化 ----------
    def save_state(self):
        state = {'modules': [], 'main_images_dir': self.main_images_dir}
        for mod in self.modules:
            state['modules'].append({
                'index': mod.index, 'images': mod.images, 'prompt': mod.prompt,
                'size_ratio': mod.size_ratio, 'is_sku': mod.is_sku, 'sku_name': mod.sku_name,
                'save_dir': mod.save_dir, 'generated_filename': mod.generated_filename, 'mode': mod.mode
            })
        try:
            with open(STATE_FILE, 'w', encoding='utf-8') as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
        except:
            pass

    def load_state(self):
        if not os.path.exists(STATE_FILE):
            return False
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                state = json.load(f)
            self.main_images_dir = state.get('main_images_dir')
            for mod_data in state['modules']:
                mod = PosterModule(mod_data['index'], mod_data.get('is_sku', False))
                mod.images = mod_data.get('images', [])
                mod.prompt = mod_data.get('prompt', '')
                mod.size_ratio = mod_data.get('size_ratio', '1:1')
                mod.sku_name = mod_data.get('sku_name', '')
                mod.save_dir = mod_data.get('save_dir')
                mod.generated_filename = mod_data.get('generated_filename')
                mod.mode = mod_data.get('mode', 'normal')
                if mod.save_dir and mod.generated_filename:
                    path = Path(mod.save_dir) / mod.generated_filename
                    if path.exists():
                        mod.generated_image = Image.open(path)
                        mod.generated_image_path = str(path)
                self.create_module_widget(mod)
                self.modules.append(mod)
                self._update_thumbs(mod)
                mod.widgets['count'].config(text=f"{len(mod.images)}/{mod.max_images}")
                if mod.prompt:
                    mod.widgets['prompt'].insert("1.0", mod.prompt)
                if mod.generated_image:
                    self._set_status(mod, "✅ 成功", "#27ae60")
            self._reflow()
            self.switch_preview()
            return True
        except Exception as e:
            log_error(f"加载状态失败: {e}")
            return False

    def on_closing(self):
        self.save_state()
        self.save_reverse_config()
        self.save_color_state()
        self.save_gpt55_history()
        self.root.destroy()

    # ---------- 高清修复 ----------
    def open_upscale(self):
        dialog = tk.Toplevel(self.root)
        dialog.title("高清修复")
        dialog.geometry("400x350")
        target = tk.StringVar(value="4K")
        for t in ["2K (2560px)", "4K (3840px)", "8K (7680px)"]:
            tk.Radiobutton(dialog, text=t, variable=target, value=t).pack()
        mode = tk.StringVar(value="增强模式")
        tk.Radiobutton(dialog, text="增强模式", variable=mode, value="增强模式").pack()
        tk.Radiobutton(dialog, text="温和模式", variable=mode, value="温和模式").pack()
        self.upscale_paths = []
        self.upscale_label = tk.Label(dialog, text="未选择图片")
        self.upscale_label.pack()
        def pick():
            paths = filedialog.askopenfilenames(filetypes=[("Images", "*.png *.jpg *.jpeg")])
            if paths:
                self.upscale_paths = list(paths)
                self.upscale_label.config(text=f"已选 {len(paths)} 张")
        tk.Button(dialog, text="选择图片", command=pick).pack()
        def start():
            if not self.upscale_paths:
                return
            target_px = {"2K (2560px)":2560, "4K (3840px)":3840, "8K (7680px)":7680}[target.get()]
            sharpen = mode.get() == "增强模式"
            dialog.destroy()
            threading.Thread(target=self._upscale_task, args=(self.upscale_paths, target_px, sharpen), daemon=True).start()
        tk.Button(dialog, text="开始修复", command=start).pack()

    def _upscale_task(self, paths, target_px, sharpen):
        for src in paths:
            try:
                img = Image.open(src).convert('RGB')
                w, h = img.size
                if w >= h:
                    new_w = target_px
                    new_h = int(h * (target_px / w))
                else:
                    new_h = target_px
                    new_w = int(w * (target_px / h))
                resized = img.resize((new_w, new_h), Image.LANCZOS)
                if sharpen:
                    scale = target_px / max(w, h)
                    radius = min(2.0, 1.0 + scale*0.5)
                    amount = min(200, 50 + scale*80)
                    resized = resized.filter(ImageFilter.UnsharpMask(radius=radius, percent=amount, threshold=3))
                base = Path(src).stem
                dst = Path(src).parent / f"{base}_upscaled.png"
                idx = 1
                while dst.exists():
                    dst = Path(src).parent / f"{base}_upscaled_{idx}.png"
                    idx += 1
                resized.save(dst)
                self.safe_ui(self.status.set, f"修复完成: {dst.name}")
            except Exception as e:
                log_error(f"高清修复失败: {e}")

    # ---------- 颜色图工具（完整实现） ----------
    def _find_font_file(self, font_name, bold=False, italic=False):
        if font_name in BUILTIN_FONTS:
            return BUILTIN_FONTS[font_name]
        imported = self.color_state.get('imported_fonts', [])
        for path in imported:
            name = os.path.splitext(os.path.basename(path))[0]
            if name == font_name:
                return path
        return None

    def open_color_sku_tool(self):
        win = tk.Toplevel(self.root)
        win.title("🎨 颜色图制作工具")
        win.geometry("950x750")
        win.transient(self.root)

        paned = ttk.PanedWindow(win, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        left_frame = ttk.Frame(paned, width=340)
        paned.add(left_frame, weight=0)
        right_frame = ttk.Frame(paned)
        paned.add(right_frame, weight=1)

        tk.Label(left_frame, text="1. 上传图片", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=10, pady=(5,0))
        tk.Button(left_frame, text="选择图片", command=lambda: self._color_tool_upload(win)).pack(pady=5, padx=10)
        self.color_img_path = tk.StringVar(value=self.color_state.get('img_path', ''))
        self.color_img_label = tk.Label(left_frame, text=os.path.basename(self.color_img_path.get()) if self.color_img_path.get() else "未选择图片", fg='blue')
        self.color_img_label.pack(padx=10, fill=tk.X)

        tk.Label(left_frame, text="2. 左侧拉伸宽度（像素）：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=10, pady=(15,0))
        self.stretch_width = tk.IntVar(value=self.color_state.get('stretch_width', 80))
        ttk.Scale(left_frame, from_=30, to=300, variable=self.stretch_width, command=lambda v: self._color_tool_schedule_generate(win)).pack(fill=tk.X, padx=20)

        tk.Label(left_frame, text="3. 字体选择：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=10, pady=(15,0))
        font_frame = ttk.Frame(left_frame)
        font_frame.pack(fill=tk.X, padx=10, pady=2)
        system_fonts = sorted(tkfont.families())
        builtin_names = list(BUILTIN_FONTS.keys())
        imported_names = []
        for path in self.color_state.get('imported_fonts', []):
            name = os.path.splitext(os.path.basename(path))[0]
            if name not in builtin_names and name not in system_fonts:
                imported_names.append(name)
        all_fonts = sorted(set(system_fonts + builtin_names + imported_names))
        default_font = self.color_state.get('font_name', '白无常可可体常规')
        if default_font not in all_fonts:
            default_font = all_fonts[0] if all_fonts else 'Arial'
        self.color_font_name = tk.StringVar(value=default_font)
        ttk.Combobox(font_frame, textvariable=self.color_font_name, values=all_fonts, width=30).pack(side=tk.LEFT, fill=tk.X, expand=True)

        style_frame = ttk.Frame(left_frame)
        style_frame.pack(fill=tk.X, padx=10, pady=2)
        self.color_bold = tk.BooleanVar(value=self.color_state.get('bold', False))
        self.color_italic = tk.BooleanVar(value=self.color_state.get('italic', False))
        tk.Checkbutton(style_frame, text="加粗", variable=self.color_bold, command=lambda: self._color_tool_schedule_generate(win)).pack(side=tk.LEFT, padx=5)
        tk.Checkbutton(style_frame, text="斜体", variable=self.color_italic, command=lambda: self._color_tool_schedule_generate(win)).pack(side=tk.LEFT, padx=5)

        color_frame = ttk.Frame(left_frame)
        color_frame.pack(fill=tk.X, padx=10, pady=2)
        ttk.Label(color_frame, text="文字颜色:").pack(side=tk.LEFT)
        self.text_color_var = tk.StringVar(value=self.color_state.get('text_color', 'black'))
        ttk.Combobox(color_frame, textvariable=self.text_color_var, values=['black', 'white'], width=6, state='readonly').pack(side=tk.LEFT, padx=5)

        tk.Label(left_frame, text="4. 输入三排文字：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=10, pady=(15,0))
        self.text_lines = []
        self.size_vars = []
        self.y_vars = []
        self.x_vars = []
        for i in range(1, 4):
            f = ttk.Frame(left_frame)
            f.pack(fill=tk.X, padx=10, pady=2)
            ttk.Label(f, text=f"第{i}排：", width=6).pack(side=tk.LEFT)
            entry = ttk.Entry(f, font=('Arial', 10))
            entry.insert(0, self.color_state.get('text_lines', ['','',''])[i-1])
            entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=2)
            entry.bind('<KeyRelease>', lambda e: self._color_tool_schedule_generate(win))
            self.text_lines.append(entry)

            ttk.Label(f, text="字号:", width=6).pack(side=tk.LEFT, padx=(5,0))
            size_var = tk.IntVar(value=self.color_state.get('font_sizes', [24,24,24])[i-1])
            ttk.Spinbox(f, from_=8, to=120, width=4, textvariable=size_var, command=lambda: self._color_tool_schedule_generate(win)).pack(side=tk.LEFT, padx=2)
            self.size_vars.append(size_var)

            ttk.Label(f, text="Y:", width=4).pack(side=tk.LEFT, padx=(5,0))
            y_var = tk.IntVar(value=self.color_state.get('y_offsets', [490,606,710])[i-1])
            ttk.Spinbox(f, from_=50, to=1200, width=5, textvariable=y_var, command=lambda: self._color_tool_schedule_generate(win)).pack(side=tk.LEFT, padx=2)
            self.y_vars.append(y_var)

            ttk.Label(f, text="X:", width=4).pack(side=tk.LEFT, padx=(5,0))
            x_var = tk.IntVar(value=self.color_state.get('x_offsets', [0,0,0])[i-1])
            ttk.Spinbox(f, from_=-500, to=500, width=5, textvariable=x_var, command=lambda: self._color_tool_schedule_generate(win)).pack(side=tk.LEFT, padx=2)
            self.x_vars.append(x_var)

        tk.Label(left_frame, text="5. 图片水平偏移：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=10, pady=(15,0))
        h_offset = tk.IntVar(value=self.color_state.get('h_offset', 0))
        ttk.Scale(left_frame, from_=-150, to=150, variable=h_offset, command=lambda v: self._color_tool_schedule_generate(win)).pack(fill=tk.X, padx=20)

        tk.Label(left_frame, text="预览缩放：", font=('Arial',10,'bold')).pack(anchor=tk.W, padx=10, pady=(10,0))
        preview_scale = tk.DoubleVar(value=self.color_state.get('preview_scale', 1.0))
        ttk.Scale(left_frame, from_=0.1, to=3.0, variable=preview_scale, command=lambda v: self._color_tool_refresh_preview(win)).pack(fill=tk.X, padx=20)

        self.color_tool_h_offset = h_offset
        self.color_tool_preview_scale = preview_scale
        self.color_tool_win = win
        self.color_tool_generate_timer = None

        btn_frame = ttk.Frame(left_frame)
        btn_frame.pack(pady=15)
        tk.Button(btn_frame, text="生成预览", command=lambda: self._color_tool_generate(win), bg="#4CAF50", fg="white", padx=10).pack(side=tk.LEFT, padx=5)
        tk.Button(btn_frame, text="导出PNG", command=lambda: self._color_tool_export(win), bg="#2196F3", fg="white", padx=10).pack(side=tk.LEFT, padx=5)
        tk.Button(btn_frame, text="一键保存到原图目录", command=lambda: self._color_tool_save_to_original(win), bg="#FF9800", fg="white", padx=10).pack(side=tk.LEFT, padx=5)

        self.color_tool_canvas = tk.Canvas(right_frame, bg='white', highlightthickness=1)
        self.color_tool_canvas.pack(fill=tk.BOTH, expand=True)
        self.color_tool_result_img = None
        self._pan_x, self._pan_y = 0, 0
        self.color_tool_canvas.bind("<ButtonPress-1>", self._color_tool_start_pan)
        self.color_tool_canvas.bind("<B1-Motion>", self._color_tool_pan)
        self.color_tool_canvas.bind("<ButtonRelease-1>", self._color_tool_end_pan)

        def on_close():
            self.color_state['img_path'] = self.color_img_path.get()
            self.color_state['text_lines'] = [e.get() for e in self.text_lines]
            self.color_state['font_sizes'] = [v.get() for v in self.size_vars]
            self.color_state['y_offsets'] = [v.get() for v in self.y_vars]
            self.color_state['x_offsets'] = [v.get() for v in self.x_vars]
            self.color_state['stretch_width'] = self.stretch_width.get()
            self.color_state['font_name'] = self.color_font_name.get()
            self.color_state['bold'] = self.color_bold.get()
            self.color_state['italic'] = self.color_italic.get()
            self.color_state['text_color'] = self.text_color_var.get()
            self.color_state['h_offset'] = h_offset.get()
            self.color_state['preview_scale'] = preview_scale.get()
            self.save_color_state()
            win.destroy()
        win.protocol("WM_DELETE_WINDOW", on_close)

        if self.color_img_path.get() and os.path.exists(self.color_img_path.get()):
            self.root.after(100, lambda: self._color_tool_generate(win))

    def _color_tool_upload(self, win):
        path = filedialog.askopenfilename(filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp")])
        if path:
            self.color_img_path.set(path)
            self.color_img_label.config(text=os.path.basename(path))
            self._color_tool_generate(win)

    def _color_tool_schedule_generate(self, win):
        if self.color_tool_generate_timer:
            self.root.after_cancel(self.color_tool_generate_timer)
        self.color_tool_generate_timer = self.root.after(200, lambda: self._color_tool_generate(win))

    def _color_tool_generate(self, win):
        path = self.color_img_path.get()
        if not path or not os.path.exists(path):
            return
        try:
            img = Image.open(path).convert('RGB')
        except Exception as e:
            messagebox.showerror("错误", f"无法打开图片: {e}")
            return

        stretch = self.stretch_width.get()
        texts = [e.get().strip() for e in self.text_lines]
        sizes = [v.get() for v in self.size_vars]
        y_offsets = [v.get() for v in self.y_vars]
        x_offsets = [v.get() for v in self.x_vars]
        h_offset = self.color_tool_h_offset.get()
        font_name = self.color_font_name.get()
        bold = self.color_bold.get()
        italic = self.color_italic.get()
        text_color = self.text_color_var.get()
        fill_color = (0,0,0) if text_color == 'black' else (255,255,255)

        target_size = 1254
        w, h = img.size
        scale = max(target_size / w, target_size / h)
        new_w, new_h = int(w * scale), int(h * scale)
        img_resized = img.resize((new_w, new_h), Image.LANCZOS)
        left = (new_w - target_size)//2
        top = (new_h - target_size)//2
        img_cropped = img_resized.crop((left, top, left+target_size, top+target_size))

        if h_offset != 0:
            canvas_big = Image.new('RGB', (target_size + abs(h_offset), target_size), (255,255,255))
            paste_x = max(h_offset, 0)
            canvas_big.paste(img_cropped, (paste_x, 0))
            if h_offset >= 0:
                img_shifted = canvas_big.crop((0, 0, target_size, target_size))
            else:
                img_shifted = canvas_big.crop((-h_offset, 0, target_size - h_offset, target_size))
            img_shifted = img_shifted.copy()
        else:
            img_shifted = img_cropped

        result = Image.new('RGB', (target_size + stretch, target_size), (255,255,255))
        result.paste(img_shifted, (stretch, 0))
        left_col = img_shifted.crop((0,0,1,target_size))
        stretched_left = left_col.resize((stretch, target_size), Image.LANCZOS)
        result.paste(stretched_left, (0,0))

        draw = ImageDraw.Draw(result)
        font_path = self._find_font_file(font_name, bold, italic)
        font = None
        if font_path and os.path.exists(font_path):
            try:
                font = ImageFont.truetype(font_path, sizes[0] if sizes else 24)
            except:
                pass
        if font is None:
            font = ImageFont.load_default()

        for i, text in enumerate(texts):
            if not text: continue
            size = sizes[i] if i < len(sizes) else 24
            y = y_offsets[i] if i < len(y_offsets) else 490 + i*116
            x = x_offsets[i] if i < len(x_offsets) else 0
            try:
                if hasattr(font, 'path'):
                    font = ImageFont.truetype(font.path, size)
                else:
                    font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
            except:
                font = ImageFont.load_default()
            draw.text((x, y), text, font=font, fill=fill_color, anchor='mm')

        result = result.crop((0, 0, target_size, target_size))
        self.color_tool_result_img = result
        self._color_tool_show_preview(win, result)

    def _color_tool_show_preview(self, win, img):
        canvas = self.color_tool_canvas
        canvas_w = canvas.winfo_width()
        canvas_h = canvas.winfo_height()
        if canvas_w <= 1 or canvas_h <= 1:
            canvas_w, canvas_h = 500, 500
        scale = self.color_tool_preview_scale.get()
        new_w, new_h = int(img.width * scale), int(img.height * scale)
        if new_w < 1: new_w = 1
        if new_h < 1: new_h = 1
        display = img.resize((new_w, new_h), Image.LANCZOS) if scale != 1.0 else img.copy()
        photo = ImageTk.PhotoImage(display)
        canvas.delete("all")
        canvas.create_image((canvas_w - new_w)//2 + self._pan_x, (canvas_h - new_h)//2 + self._pan_y, image=photo, anchor='nw')
        canvas.image = photo
        canvas.config(scrollregion=(0, 0, new_w, new_h))

    def _color_tool_refresh_preview(self, win):
        if self.color_tool_result_img:
            self._color_tool_show_preview(win, self.color_tool_result_img)

    def _color_tool_export(self, win):
        if not self.color_tool_result_img:
            return
        path = filedialog.asksaveasfilename(defaultextension=".png", filetypes=[("PNG", "*.png")])
        if path:
            self.color_tool_result_img.save(path)
            self.status.set(f"颜色图已导出: {path}")

    def _color_tool_save_to_original(self, win):
        if not self.color_tool_result_img:
            return
        src_path = self.color_img_path.get()
        if not src_path:
            return
        src_dir = os.path.dirname(src_path)
        texts = [e.get().strip() for e in self.text_lines]
        name = "_".join(t for t in texts if t) or "颜色图"
        name = re.sub(r'[\\/*?:"<>|]', '', name)
        candidate = os.path.join(src_dir, f"{name}.png")
        idx = 1
        while os.path.exists(candidate):
            candidate = os.path.join(src_dir, f"{name}_{idx}.png")
            idx += 1
        self.color_tool_result_img.save(candidate)
        self.status.set(f"已保存: {candidate}")
        messagebox.showinfo("完成", f"图片已保存到:\n{candidate}")

    def _color_tool_start_pan(self, event):
        self._pan_start_x, self._pan_start_y = event.x, event.y

    def _color_tool_pan(self, event):
        dx = event.x - self._pan_start_x
        dy = event.y - self._pan_start_y
        self._pan_x += dx
        self._pan_y += dy
        self._pan_start_x, self._pan_start_y = event.x, event.y
        self._color_tool_refresh_preview(self.color_tool_win)

    def _color_tool_end_pan(self, event):
        pass

    # ---------- GPT5.5 对话窗口（增强版：拖选、复制按钮、发送到模块、模式切换） ----------
    def open_gpt55_chat(self):
        if self.gpt55_win is not None and self.gpt55_win.winfo_exists():
            self.gpt55_win.lift()
            self.gpt55_win.focus_force()
            return

        self.gpt55_win = tk.Toplevel(self.root)
        self.gpt55_win.title("GPT5.5 智能助手")
        self.gpt55_win.geometry("860x740")
        self.gpt55_win.configure(bg='#121212')
        self.gpt55_win.protocol("WM_DELETE_WINDOW", self._on_gpt55_close)

        header = tk.Frame(self.gpt55_win, bg='#1e1e1e', height=56)
        header.pack(fill=tk.X)
        header.pack_propagate(False)
        title_lbl = tk.Label(header, text="GPT5.5 智能对话", bg='#1e1e1e', fg='#eee', font=('Arial', 14, 'bold'))
        title_lbl.pack(side=tk.LEFT, padx=16)

        self.gpt55_model_var = tk.StringVar(value=self.tier)
        model_combo = ttk.Combobox(header, textvariable=self.gpt55_model_var, values=TIER_CHOICES, width=12, state='readonly')
        model_combo.pack(side=tk.LEFT, padx=20)

        # 模式切换
        mode_frame = tk.Frame(header, bg='#1e1e1e')
        mode_frame.pack(side=tk.LEFT, padx=10)
        self.gpt55_mode_text = tk.StringVar(value="文本模式")
        text_btn = tk.Button(mode_frame, text="文本模式", command=lambda: self._set_gpt55_mode("text"),
                             bg='#2a2a2a', fg='#eee', relief='flat', padx=8, pady=2)
        text_btn.pack(side=tk.LEFT, padx=2)
        code_btn = tk.Button(mode_frame, text="代码模式", command=lambda: self._set_gpt55_mode("code"),
                             bg='#2a2a2a', fg='#eee', relief='flat', padx=8, pady=2)
        code_btn.pack(side=tk.LEFT, padx=2)
        self.gpt55_text_btn = text_btn
        self.gpt55_code_btn = code_btn

        clear_btn = tk.Button(header, text="清空对话", command=self._clear_gpt55_chat,
                              bg='#E74C3C', fg='white', relief='flat', padx=10, pady=2, font=('Arial',9))
        clear_btn.pack(side=tk.RIGHT, padx=16)

        chat_bg = tk.Frame(self.gpt55_win, bg='#121212')
        chat_bg.pack(fill=tk.BOTH, expand=True, padx=0, pady=0)
        self.gpt55_chat_canvas = tk.Canvas(chat_bg, bg='#121212', highlightthickness=0)
        scrollbar = ttk.Scrollbar(chat_bg, orient=tk.VERTICAL, command=self.gpt55_chat_canvas.yview)
        self.gpt55_chat_canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.gpt55_chat_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.gpt55_chat_frame = tk.Frame(self.gpt55_chat_canvas, bg='#121212')
        self.gpt55_chat_canvas.create_window((0,0), window=self.gpt55_chat_frame, anchor='nw')
        self.gpt55_chat_frame.bind("<Configure>", lambda e: self.gpt55_chat_canvas.configure(scrollregion=self.gpt55_chat_canvas.bbox("all")))
        self.gpt55_chat_canvas.bind("<Configure>", self._gpt55_resize_chat)
        self.gpt55_chat_canvas.bind("<MouseWheel>", lambda e: self.gpt55_chat_canvas.yview_scroll(int(-1*(e.delta/120)), "units"))

        input_bg = tk.Frame(self.gpt55_win, bg='#1e1e1e')
        input_bg.pack(fill=tk.X, padx=0, pady=0)

        self.gpt55_attach_frame = tk.Frame(input_bg, bg='#1e1e1e')
        self.gpt55_attach_frame.pack(fill=tk.X, padx=16, pady=(8,0))
        self.gpt55_img_paths = []
        self._gpt55_update_attach_preview()

        input_row = tk.Frame(input_bg, bg='#1e1e1e')
        input_row.pack(fill=tk.X, padx=16, pady=(4,10))

        upload_btn = tk.Button(input_row, text="+", font=('Arial', 16, 'bold'), bg='#2a2a2a', fg='#eee',
                               relief='flat', padx=8, pady=2, command=self._gpt55_upload_image)
        upload_btn.pack(side=tk.LEFT)
        if HAS_DND:
            upload_btn.drop_target_register(DND_FILES)
            upload_btn.dnd_bind('<<Drop>>', self._gpt55_drop_image)

        self.gpt55_text = tk.Text(input_row, wrap=tk.WORD, font=('Arial', 11), bg='#2a2a2a', fg='#eee',
                                  insertbackground='white', bd=0, relief='flat', height=4, padx=10, pady=8,
                                  undo=True, maxundo=50)
        self.gpt55_text.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8,8))
        self.gpt55_text.bind('<KeyRelease>', self._gpt55_adjust_text_height)
        self.gpt55_text.bind('<Return>', self._gpt55_handle_enter)
        self.gpt55_text.bind("<Button-3>", self._gpt55_input_context_menu)

        send_btn = tk.Button(input_row, text="➤", font=('Arial', 14), bg='#3b82f6', fg='white',
                             relief='flat', padx=12, pady=4, command=self._gpt55_send)
        send_btn.pack(side=tk.RIGHT)

        self._load_gpt55_chat_history()
        self._update_mode_buttons()
        self.gpt55_win.focus_force()

    def _set_gpt55_mode(self, mode):
        self.gpt55_mode = mode
        self._update_mode_buttons()
        # 重新渲染聊天记录以适应新字体
        self._refresh_chat_display()

    def _update_mode_buttons(self):
        if self.gpt55_mode == "text":
            self.gpt55_text_btn.config(bg='#3b82f6')
            self.gpt55_code_btn.config(bg='#2a2a2a')
        else:
            self.gpt55_text_btn.config(bg='#2a2a2a')
            self.gpt55_code_btn.config(bg='#3b82f6')

    def _refresh_chat_display(self):
        for w in self.gpt55_chat_frame.winfo_children():
            w.destroy()
        # 使用存储的chats重新绘制
        for item in self.gpt55_chats:
            self._add_gpt55_message(item['role'], item['content'], silent=True)

    def _gpt55_resize_chat(self, event):
        canvas_width = event.width
        self.gpt55_chat_canvas.itemconfig("all", width=canvas_width)

    def _gpt55_update_attach_preview(self):
        for w in self.gpt55_attach_frame.winfo_children():
            w.destroy()
        for idx, path in enumerate(self.gpt55_img_paths):
            try:
                img = Image.open(path)
                img.thumbnail((60, 60), Image.LANCZOS)
                photo = ImageTk.PhotoImage(img)
                frame = tk.Frame(self.gpt55_attach_frame, bg='#2a2a2a')
                frame.pack(side=tk.LEFT, padx=4, pady=2)
                lbl = tk.Label(frame, image=photo, bg='#2a2a2a')
                lbl.image = photo
                lbl.pack()
                close_btn = tk.Label(frame, text="×", bg='#ff4444', fg='white', font=('Arial',8,'bold'), cursor='hand2')
                close_btn.place(relx=1.0, x=-2, y=2, anchor='ne')
                close_btn.bind("<Button-1>", lambda e, i=idx: self._gpt55_remove_image(i))
            except:
                pass

    def _gpt55_add_image(self, path):
        if len(self.gpt55_img_paths) >= 10:
            messagebox.showwarning("提示", "最多上传10张图片")
            return
        if path not in self.gpt55_img_paths:
            self.gpt55_img_paths.append(path)
        self._gpt55_update_attach_preview()

    def _gpt55_remove_image(self, idx):
        if 0 <= idx < len(self.gpt55_img_paths):
            del self.gpt55_img_paths[idx]
        self._gpt55_update_attach_preview()

    def _gpt55_upload_image(self, event=None):
        paths = filedialog.askopenfilenames(filetypes=[("Images", "*.png *.jpg *.jpeg")])
        for p in paths:
            if len(self.gpt55_img_paths) >= 10:
                break
            self._gpt55_add_image(p)

    def _gpt55_drop_image(self, event):
        data = event.data
        if data.startswith('{') and data.endswith('}'):
            data = data[1:-1]
        for p in data.split():
            p = p.strip()
            if os.path.isfile(p):
                if len(self.gpt55_img_paths) >= 10:
                    break
                self._gpt55_add_image(p)

    def _gpt55_adjust_text_height(self, event=None):
        text_widget = self.gpt55_text
        lines = int(text_widget.index('end-1c').split('.')[0])
        if lines < 4:
            lines = 4
        elif lines > 12:
            lines = 12
        text_widget.configure(height=lines)

    def _gpt55_handle_enter(self, event):
        if not event.state & 0x1:  # 不按Shift
            self._gpt55_send()
            return "break"
        return None

    def _gpt55_send(self):
        text = self.gpt55_text.get("1.0", tk.END).strip()
        imgs = self.gpt55_img_paths.copy()
        if not text and not imgs:
            return
        self._add_gpt55_message("user", text, imgs)
        self.gpt55_text.delete("1.0", tk.END)
        self.gpt55_img_paths.clear()
        self._gpt55_update_attach_preview()

        if self.gpt55_loading:
            self.gpt55_loading.destroy()
        self.gpt55_loading = tk.Label(self.gpt55_chat_frame, text="GPT5.5 思考中…", bg='#121212', fg='#888',
                                      font=('Arial', 9, 'italic'))
        self.gpt55_loading.pack(pady=5)
        self.gpt55_chat_canvas.yview_moveto(1.0)

        selected_model = self.gpt55_model_var.get()
        threading.Thread(target=self._gpt55_api_call, args=(text, imgs, selected_model), daemon=True).start()

    def _gpt55_api_call(self, text, img_paths, model):
        max_retries = 3
        for attempt in range(max_retries):
            try:
                messages = self.gpt55_conversation.copy()
                user_content = []
                for img_path in img_paths:
                    with open(img_path, "rb") as f:
                        img_data = base64.b64encode(f.read()).decode('utf-8')
                    user_content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_data}"}})
                if text:
                    user_content.append({"type": "text", "text": text})
                messages.append({"role": "user", "content": user_content})
                result = bridge_chat(messages, tier=model, timeout=(10, 300))
                reply = result["choices"][0]["message"]["content"]
                self.safe_ui(self._remove_loading)
                self.safe_ui(self._add_gpt55_message, "ai", reply)
                return
            except requests.exceptions.ReadTimeout:
                if attempt < max_retries - 1:
                    time.sleep(2)
                    continue
                self.safe_ui(self._remove_loading)
                self.safe_ui(self._add_gpt55_message, "ai", "请求超时，请稍后重试")
                return
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2)
                    continue
                self.safe_ui(self._remove_loading)
                self.safe_ui(self._add_gpt55_message, "ai", f"请求异常: {e}")
                return

    def _remove_loading(self):
        if self.gpt55_loading:
            self.gpt55_loading.destroy()
            self.gpt55_loading = None

    def _add_gpt55_message(self, role, content, img_paths=None, silent=False):
        is_ai = role == 'ai'
        bubble_bg = '#F5F5F5' if is_ai else '#DBEAFE'
        text_fg = '#1f2937' if is_ai else '#1e3a8a'
        timestamp = datetime.now().strftime("%H:%M")
        font_body = ('Consolas', 10) if self.gpt55_mode == 'code' else ('Arial', 10)

        # 一行 = 头像 + 气泡（气泡贴边，不占满，符合聊天 App 习惯）
        row = tk.Frame(self.gpt55_chat_frame, bg='#121212')
        row.pack(fill=tk.X, padx=12, pady=8)

        avatar = tk.Label(row, text=('GPT' if is_ai else '我'),
                          bg=('#3b82f6' if is_ai else '#6b7280'), fg='white',
                          font=('Arial', 9, 'bold'), width=3, height=2)
        avatar.pack(side=(tk.LEFT if is_ai else tk.RIGHT), padx=(0, 8), anchor='n')

        bubble = tk.Frame(row, bg=bubble_bg)
        bubble.pack(side=(tk.LEFT if is_ai else tk.RIGHT), anchor='n')

        # 图片（仅用户）
        if role == 'user' and img_paths:
            ifrm = tk.Frame(bubble, bg=bubble_bg)
            ifrm.pack(fill=tk.X, padx=10, pady=(10, 2))
            for ip in img_paths:
                try:
                    im = Image.open(ip); im.thumbnail((120, 120), Image.LANCZOS)
                    ph = ImageTk.PhotoImage(im)
                    lb = tk.Label(ifrm, image=ph, bg=bubble_bg); lb.image = ph
                    lb.pack(side=tk.LEFT, padx=3)
                except Exception:
                    pass

        # 文字：单个 Text 整体渲染，宽度固定 62 字符、高度按 displaylines 自适应。
        # 旧版拆 title/body 且 height=1，多行回复被裁成 1 行 → "显示一坨"。
        if content:
            t = tk.Text(bubble, width=62, wrap=tk.WORD, font=font_body, bg=bubble_bg, fg=text_fg,
                        bd=0, relief='flat', highlightthickness=0, padx=14, pady=10,
                        spacing1=2, spacing3=2)
            t.insert('1.0', content.rstrip())
            t.configure(state=tk.DISABLED)
            t.pack()
            self._make_text_selectable(t)
            self._fit_text(t)

        # 操作栏：复制 / 发送到模块 / 时间戳
        act = tk.Frame(bubble, bg=bubble_bg)
        act.pack(fill=tk.X, padx=10, pady=(0, 8))
        if content:
            tk.Button(act, text="复制", font=('Arial', 8), bg='#e5e7eb', fg='#374151',
                      relief='flat', bd=0, padx=8,
                      command=lambda c=content: self.root.clipboard_append(c)).pack(side=tk.LEFT, padx=2)
        if is_ai:
            tk.Button(act, text="发送到模块", font=('Arial', 8), bg='#bfdbfe', fg='#1e40af',
                      relief='flat', bd=0, padx=8,
                      command=lambda c=content: self._send_gpt_to_module(c)).pack(side=tk.LEFT, padx=2)
        tk.Label(act, text=timestamp, bg=bubble_bg, fg='#9ca3af', font=('Arial', 8)).pack(side=tk.RIGHT)

        self.gpt55_chat_canvas.update_idletasks()
        self.gpt55_chat_canvas.yview_moveto(1.0)

        if not silent:
            if role == 'user':
                user_content = []
                if img_paths:
                    for ip in img_paths:
                        user_content.append({"type": "image_url", "image_url": {"url": f"placeholder:{ip}"}})
                if content:
                    user_content.append({"type": "text", "text": content})
                self.gpt55_conversation.append({"role": "user", "content": user_content})
            else:
                self.gpt55_conversation.append({"role": "assistant", "content": content})
            self.gpt55_chats.append({"role": role, "content": content, "timestamp": datetime.now().isoformat()})
            self.save_gpt55_history()

    def _send_gpt_to_module(self, content):
        """将GPT回复创建为新模块并填入标题和提示词"""
        lines = content.split('\n')
        title = lines[0].strip() if lines else "GPT创意"
        prompt = content
        # 添加新模块
        self.add_module()
        mod = self.modules[-1]
        mod.widgets['title'].delete(0, tk.END)
        mod.widgets['title'].insert(0, title[:60])
        mod.widgets['prompt'].delete("1.0", tk.END)
        mod.widgets['prompt'].insert("1.0", prompt)
        mod.prompt = prompt
        self.status.set(f"已创建模块: {title}")

    def _fit_text(self, text_widget):
        """按 wrapping 实际显示行数自适应 Text 高度（修复旧版 height=1 把多行裁成 1 行）。"""
        def apply():
            try:
                text_widget.update_idletasks()
                counts = text_widget.count('1.0', 'end-1c', 'displaylines')
                n = counts[0] if counts else 1
            except Exception:
                n = max(1, int(text_widget.index('end-1c').split('.')[0]))
            try:
                text_widget.configure(height=max(1, n))
            except Exception:
                pass
        self.gpt55_win.after_idle(apply)

    def _make_text_selectable(self, text_widget):
        text_widget.bind("<Button-1>", lambda e: text_widget.focus_set())
        text_widget.bind("<Control-c>", lambda e: text_widget.event_generate("<<Copy>>"))
        text_widget.bind("<Button-3>", lambda e: self._gpt55_text_context_menu(e, text_widget))

    def _gpt55_text_context_menu(self, event, text_widget):
        menu = tk.Menu(text_widget, tearoff=0)
        menu.add_command(label="复制", command=lambda: text_widget.event_generate("<<Copy>>"))
        menu.post(event.x_root, event.y_root)

    def _gpt55_input_context_menu(self, event):
        menu = tk.Menu(self.gpt55_text, tearoff=0)
        menu.add_command(label="撤销", command=lambda: self.gpt55_text.edit_undo())
        menu.add_command(label="重做", command=lambda: self.gpt55_text.edit_redo())
        menu.add_separator()
        menu.add_command(label="剪切", command=lambda: self.gpt55_text.event_generate("<<Cut>>"))
        menu.add_command(label="复制", command=lambda: self.gpt55_text.event_generate("<<Copy>>"))
        menu.add_command(label="粘贴", command=lambda: self.gpt55_text.event_generate("<<Paste>>"))
        menu.post(event.x_root, event.y_root)

    def _load_gpt55_chat_history(self):
        for w in self.gpt55_chat_frame.winfo_children():
            w.destroy()
        self.gpt55_conversation.clear()
        for item in self.gpt55_chats:
            self._add_gpt55_message(item['role'], item['content'], silent=True)
            if item['role'] == 'user':
                self.gpt55_conversation.append({"role": "user", "content": [{"type": "text", "text": item['content']}]})
            else:
                self.gpt55_conversation.append({"role": "assistant", "content": item['content']})
        self.save_gpt55_history()

    def _clear_gpt55_chat(self):
        for w in self.gpt55_chat_frame.winfo_children():
            w.destroy()
        self.gpt55_chats = []
        self.gpt55_conversation = []
        self.save_gpt55_history()

    def _on_gpt55_close(self):
        self.gpt55_win.destroy()
        self.gpt55_win = None

# ---------- 启动 ----------
if __name__ == "__main__":
    if not bridge_ready():
        _root = tk.Tk()
        _root.withdraw()
        messagebox.showerror("无法启动", "本插件必须在灵坊桌面客户端中运行（缺少平台桥环境变量）。")
        sys.exit(1)
    root = TkinterDnD.Tk() if HAS_DND else tk.Tk()
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except: pass
    app = App(root)
    root.mainloop()
