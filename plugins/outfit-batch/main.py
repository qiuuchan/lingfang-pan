import sys, os, json, time, shutil, requests, base64, random, string, mimetypes, logging, gc, traceback, io, threading
from datetime import datetime, timedelta
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps
from PyQt5.QtWidgets import *
from PyQt5.QtCore import *
from PyQt5.QtGui import *

# ==================== 全局异常捕获 ====================
def global_exception_handler(exc_type, exc_value, exc_tb):
    logging.error(f"未捕获异常: {exc_type.__name__}: {exc_value}")
    logging.error(traceback.format_exc())
sys.excepthook = global_exception_handler

os.makedirs("data", exist_ok=True)
logging.basicConfig(filename=os.path.join('data', 'app.log'), level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ============ 配置 ============
app_settings = QSettings("AIGenTool", "Settings")

# ---------- 平台桥配置 ----------
# AI 调用经平台本地桥，由桌面壳注入环境变量；插件不持有任何密钥或端点。
# 读取桥变量不得带 fallback 默认值（平台 AI 政策要求）。
_BRIDGE_URL = os.environ.get("LINGFANG_PLUGIN_BRIDGE_URL")
_BRIDGE_TOKEN = os.environ.get("LINGFANG_PLUGIN_BRIDGE_TOKEN")

# 档位：fast（快速）/ premium（高级），决定上游命中模型与计费；默认 fast。
TIER_CHOICES = ["fast", "premium"]
DEFAULT_TIER = "fast"

DEFAULT_IMAGE_DIR = Path(__file__).parent / "data" / "image"
DEFAULT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)


def bridge_ready():
    """是否在桌面壳内运行（桥变量已注入）。"""
    return bool(_BRIDGE_URL and _BRIDGE_TOKEN)


def _bridge_headers():
    return {"X-LingFang-Plugin-Token": _BRIDGE_TOKEN}


class BridgeError(Exception):
    """桥调用失败。携带 status/code 供重试判定（401/403/402 等鉴权/余额错误不重试）。"""
    def __init__(self, message, status=0, code=""):
        super().__init__(message)
        self.status = status
        self.code = code


def bridge_error_is_retryable(err):
    """是否值得重试。

    重试只对瞬态错误有意义：网络错误(status=0)/429/5xx。
    鉴权(401/403)/余额(402)/其它客户端 4xx 不会自愈——重试只空等（旧版 401 会
    空耗 重试次数×退避 ≈ 10 分钟才报错）。status==0 视为网络/未知，按瞬态重试。
    """
    status = getattr(err, "status", 0) or 0
    if status == 0:
        return True
    return status == 429 or status >= 500


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
        # 桥错误 body 含 code/message/requestId，拼进异常便于诊断（不丢上下文）。
        # 抛 BridgeError 携带 status/code，供重试循环按错误类型决定是否重试。
        try:
            ej = resp.json()
            raise BridgeError("桥 image.edit %s %s: %s%s" % (
                resp.status_code, ej.get("code", ""), ej.get("message", resp.text[:200]),
                (" (requestId=" + ej["requestId"] + ")") if ej.get("requestId") else ""),
                status=resp.status_code, code=str(ej.get("code", "")))
        except ValueError:
            raise BridgeError("桥 image.edit %s: %s" % (resp.status_code, resp.text[:200]),
                              status=resp.status_code)
    return resp.json().get("images", [])


def fetch_image_bytes(src):
    """桥返回的图片可能是 data:URI 或 http URL，统一拿回字节。"""
    if src.startswith("data:"):
        _, b64 = src.split(",", 1)
        return base64.b64decode(b64)
    resp = requests.get(src, timeout=(10, 120))
    resp.raise_for_status()
    return resp.content
RESOLUTION_SUPPORTED_RATIOS = {
    "1K": ["1:1", "3:4", "9:16", "3:2", "4:3", "16:9", "2:3", "2:1", "1:2"],
    "2K": ["1:1", "3:4", "9:16", "3:2", "4:3", "16:9", "2:3", "2:1", "1:2"]
}
# ---------- 出图比例 → 上游标准 size / 目标精确像素 ----------
# 上游 image-edit 模型只认标准 size（1024x1024 / 1024x1536 / 1536x1024），任意自定义像素值
# （如 768x1024 / 576x1024）会被忽略（→ 按参考图比例出图，常表现为「选 1:1 出竖图」）或报错。
# 故请求层统一发标准 size；落盘前再用 Pillow center-crop 到目标精确像素，保证「选什么比例出什么比例」。
# 与 detail-poster 同款双保险（detail-poster/main.py L132-158 已验证）。
RATIO_STANDARD_SIZE = {
    "1:1": "1024x1024",
    # 竖图统一发 1024x1536
    "3:4": "1024x1536", "9:16": "1024x1536", "2:3": "1024x1536", "1:2": "1024x1536",
    # 横图统一发 1536x1024
    "4:3": "1536x1024", "16:9": "1536x1024", "3:2": "1536x1024", "2:1": "1536x1024",
}
# 目标精确像素（W:H 严格等于比例，长边对齐 1536），用于落盘前 center-crop。
RATIO_PIXELS = {
    "1:1": (1024, 1024),
    "3:4": (1152, 1536),   # W:H = 3:4
    "9:16": (864, 1536),   # W:H = 9:16
    "2:3": (1024, 1536),   # W:H = 2:3
    "1:2": (768, 1536),    # W:H = 1:2
    "4:3": (1536, 1152),   # W:H = 4:3
    "16:9": (1536, 864),   # W:H = 16:9
    "3:2": (1536, 1024),   # W:H = 3:2
    "2:1": (1536, 768),    # W:H = 2:1
}


def _crop_to_ratio(img, ratio):
    """按目标比例 center-crop 到精确像素（ImageOps.fit）。ratio 不在表里或失败时原样返回。"""
    target = RATIO_PIXELS.get(ratio)
    if not target:
        return img
    try:
        return ImageOps.fit(img, target, Image.LANCZOS)
    except Exception:
        return img

DEFAULT_PASSPHRASE_PROMPT = "展示人物全身图，专业摄影，像素级的面料纹理，质感清晰，焦点清晰，电影级布光，景深效果。高清画质"
CHANGE_CLOTHES_PROMPT_TEMPLATE = """把图2全套（上衣+裤子+内搭）换到图1身上，图1保持姿态背景不变。严格保持图1的面部特征、表情、五官、皮肤纹理、肤色完全不变，面部不得出现任何色斑、色块、噪点或模糊。去除图1文字字母banner标签横条幅小海报遮挡物，严格保持人物身材比例的一致性。要求极高精度与细节还原，像素级的面料纹理，逼真的光线，焦点清晰，高清质感"""
CHANGE_INNER_PROMPT_TEMPLATE = """让图1的模特穿上图2所示内搭服装，保持外套不变，保持模特的面部表情和身体姿势完全不变，保持图2内搭细节颜色完全一致。"""
CHANGE_FACE_PROMPT_TEMPLATE = """将图2的头像换到图1的人物身上，保持图1的身体姿势、服装、背景完全不变，保持图2的面部特征、发型、表情，要求自然融合，光影一致。"""
MULTI_PERSON_CHANGE_CLOTHES_TEMPLATE = """把图2和图3的整套衣服，穿到图1的{person_count}个人物身上，保持图2和图3的衣服细节不变，保留图1的背景，细节材质完整自然，纹理平滑统一，主体清晰，背景层次分明，避免过度锐化，色斑，碎纹崩坏和畸变，去除图1文字字母banner标签横条幅小海报遮挡物，去除图1的所有水印logo，banner横条。"""
MULTI_PERSON_CHANGE_INNER_TEMPLATE = """把图2和图3的整套内搭衣服，穿到图1的{person_count}个人物身上，保持外套不变，保持图2和图3的内搭细节颜色完全一致，保留图1的背景和外套，细节材质完整自然。"""
MULTI_PERSON_CHANGE_FACE_TEMPLATE = """将图2的头像换到图1的{person_count}个人物身上，保持图1的身体姿势、服装、背景完全不变，保持图2的面部特征、发型、表情，要求自然融合，光影一致。"""
FISSION_PROMPT_TEMPLATE = """请根据产品图，生成不同姿势的图片，人物走位姿势、动作、朝向、构图全不重复。要求：保留原图人物的面部特征、身形、服装款式和细节。严格保留原图服装的颜色，不允许有丝毫颜色差别。严格执行一张图只能有1个模特，移步变换位置，动态多样，无原地重复姿势。身材比例协调，身形挺拔。专业摄影，原图模式，高清画质。面料细节高度还原，呈现皮肤纹理。逼真的光线，焦点清晰。禁止出现和原图完全相同的姿势"""
MULTI_PERSON_FISSION_TEMPLATE = """图中{person_count}个人物多姿态展示衣服，保留服装款式和细节，严格保留图1的{person_count}人的衣服细节版型颜色不允许有丝毫颜色差别，保持图1镜头下身体比例，保留图1背景，严禁展示背部，使用图1背景，要求每张的{person_count}人的姿势动作随机变化，每张图片里的{person_count}人的姿态都不相同，禁止出现宫格图片，禁止出现拼图的现象。身材比例协调，身形挺拔，细节材质完整自然，纹理平滑统一，主体清晰，背景层次分明，避免过度锐化，色斑，碎纹崩坏和畸变，去除图1的所有水印logo，banner横条。"""
FISSION_PROMPT_1V1 = FISSION_PROMPT_TEMPLATE
CREATIVE_PROMPT_TEMPLATE = "创意生成："
BATCH_CHANGE_CLOTHES_PROMPT = """请将【服装图区】中图1的全套服装（长袖西装外套+微喇长裤（长度到脚踝下1厘米）+内搭翻领衬衫+黑色领带）精确地穿着到【模特姿态区】的每个模特身上。全身图展示
要求：
1. 仅提取服装本身，完全忽略服装原图的背景、地板、阴影、任何环境元素。严禁将服装背景中的任何颜色、纹理或物体迁移到模特身后或周围。
2. 模特原有的姿态、面部特征、发型、肤色、光影、背景场景保持100%不变。只改变衣着。
3. 服装版型严格准确：长袖西装外套+微喇长裤（长度到脚踝下1厘米）+内搭翻领衬衫+黑色领带，白色翻领衬衫领子自然外翻。
4. 模特面部皮肤均匀光滑，无任何色斑、斑点、拼接痕迹。全身皮肤与原有质感一致。
5. 面料质感真实：西装外套呈现聚酯纤维的高密感和挺括感，微喇长裤有垂坠感，衬衫呈现棉麻的哑光纹理。
6. 输出格式：每张图只含一个完整人物，无多宫格、无文字、无字母、无banner、无水印、无标签条幅。
7. 极高精度，像素级纹理，焦点清晰，4K质感。"""

# ========== 性能参数（优化） ==========
DEFAULT_MAX_CONCURRENT = 12          # 优化：降低并发至12，避免瞬时熔断
DEFAULT_TIMEOUT = 3000               # 单次请求超时3000秒（上游偶发长耗时，避免假性超时）
DEFAULT_RETRY_COUNT = 5              # 优化：减少重试次数至5，降低无效重试
# 单任务总超时：需 ≥ 单次超时 × 重试次数 + 退避（3000×10 + 退避≈60×10 ≈ 30600s），取 36000s（10h）留余量。
DEFAULT_MAX_TOTAL_SECONDS = 36000
# 单次读超时硬上限：对齐桥→relay 的 600s（plugin_llm_bridge.rs:1583）。正常链路下 bridge 在 ≤600s 内
# 回包（成功或 502），不会触及此上限；仅当桥进程本身 accept 不回包（挂死）时才生效，把最坏卡死从
# 3000s×重试 收敛到 600s×重试，使总超时 watchdog 能在有限时间内真正中止任务。
READ_TIMEOUT_CAP = 600
MAX_PREVIEW_IMAGES = 200
MAX_TASK_HISTORY = 200

# ========== 设置迁移 ==========
# 旧版单次请求超时被钳制在 600s 内，历史保存值（如 200）会覆盖新默认值（3000）；
# 同步把过小的 max_total 迁移到新基线，否则 3000s 单次会在首次请求中途触发"任务超时"弹窗。
_old_timeout = app_settings.value("timeout", DEFAULT_TIMEOUT, type=int)
if 0 < _old_timeout < DEFAULT_TIMEOUT:
    app_settings.setValue("timeout", DEFAULT_TIMEOUT)
_old_max_total = app_settings.value("max_total", DEFAULT_MAX_TOTAL_SECONDS, type=int)
if 0 < _old_max_total < DEFAULT_MAX_TOTAL_SECONDS:
    app_settings.setValue("max_total", DEFAULT_MAX_TOTAL_SECONDS)

APP_CONFIG = {
    "task_expire_days": 7,
    "output_dir": str(DEFAULT_IMAGE_DIR),
    "task_db": os.path.join("data", "task_db.json"),
    "prompt_templates_db": os.path.join("data", "prompt_templates.json"),
    "auto_save_path": str(DEFAULT_IMAGE_DIR),
    "max_concurrent_tasks": app_settings.value("max_concurrent", DEFAULT_MAX_CONCURRENT, type=int),
    "timeout_seconds": app_settings.value("timeout", DEFAULT_TIMEOUT, type=int),
    "retry_count": app_settings.value("retry_count", DEFAULT_RETRY_COUNT, type=int),
    "max_total_seconds": app_settings.value("max_total", DEFAULT_MAX_TOTAL_SECONDS, type=int),
    "default_prompt_templates": [
        CHANGE_CLOTHES_PROMPT_TEMPLATE, CHANGE_INNER_PROMPT_TEMPLATE,
        CHANGE_FACE_PROMPT_TEMPLATE, FISSION_PROMPT_1V1,
        "创意无限 - 一键去水印", "创意无限 - 一键换装", DEFAULT_PASSPHRASE_PROMPT,
        BATCH_CHANGE_CLOTHES_PROMPT
    ]
}
def get_max_concurrent(): return app_settings.value("max_concurrent", DEFAULT_MAX_CONCURRENT, type=int)
def get_timeout(): return max(app_settings.value("timeout", DEFAULT_TIMEOUT, type=int), DEFAULT_TIMEOUT)
def get_retry_count(): return app_settings.value("retry_count", DEFAULT_RETRY_COUNT, type=int)
def get_max_total_seconds(): return max(app_settings.value("max_total", DEFAULT_MAX_TOTAL_SECONDS, type=int), DEFAULT_MAX_TOTAL_SECONDS)

# ==================== 内存监控 ====================
def check_memory_and_cleanup():
    try:
        import psutil
        process = psutil.Process(os.getpid())
        mem = process.memory_info().rss / 1024 / 1024
        if mem > 2000:
            logging.warning(f"内存使用 {mem:.1f}MB，触发清理")
            gc.collect()
            return True
    except: pass
    return False

# ==================== 智能锐化 & UpscaleWorker ====================
def smart_sharpen(img, radius=1.0, percent=150, threshold=0):
    if radius <= 0 or percent <= 0: return img
    return img.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold))

class UpscaleWorker(QThread):
    progress_signal = pyqtSignal(int, int)
    finished_signal = pyqtSignal(list)
    error_signal = pyqtSignal(str)
    def __init__(self, image_paths, target_resolution, gentle=False):
        super().__init__()
        self.image_paths = image_paths; self.target_resolution = target_resolution; self.gentle = gentle; self._is_cancelled = False
    def cancel(self): self._is_cancelled = True
    def run(self):
        try:
            output_paths = []
            total = len(self.image_paths)
            target_long = {"2K":2560,"4K":3840,"8K":7680}.get(self.target_resolution,3840)
            for idx, src_path in enumerate(self.image_paths):
                if self._is_cancelled: break
                try:
                    img = Image.open(src_path)
                    if img.mode not in ('RGB','L'): img = img.convert('RGB')
                    w,h = img.size
                    long_side = max(w,h)
                    scale = target_long / long_side
                    new_w, new_h = int(round(w*scale)), int(round(h*scale))
                    resized = img.resize((new_w,new_h), Image.LANCZOS)
                    if not self.gentle:
                        mag = max(scale,1.0)
                        sr,sp = (1.2,180) if mag>2.0 else (1.0,150) if mag>1.5 else (0.8,120)
                        resized = smart_sharpen(resized, radius=sr, percent=sp, threshold=0)
                    base_dir = os.path.dirname(src_path)
                    name_base = os.path.splitext(os.path.basename(src_path))[0]
                    ext = os.path.splitext(src_path)[1].lower()
                    counter = 1
                    while True:
                        new_name = f"{name_base}_{counter}{ext}"
                        new_path = os.path.join(base_dir, new_name)
                        if not os.path.exists(new_path): break
                        counter += 1
                    if ext == '.png': resized.save(new_path, 'PNG', optimize=True)
                    else: resized.save(new_path, 'JPEG', quality=95, subsampling=0)
                    output_paths.append(new_path)
                    self.progress_signal.emit(idx+1, total)
                    if idx % 5 == 0: gc.collect()
                except Exception as e:
                    self.error_signal.emit(f"放大失败 {os.path.basename(src_path)}: {str(e)}")
            self.finished_signal.emit(output_paths)
        except Exception as e:
            self.error_signal.emit(f"UpscaleWorker崩溃: {str(e)}")

# ==================== 辅助函数 ====================
def resource_path(relative_path):
    try: base_path = sys._MEIPASS
    except: base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

def generate_random_name():
    digits = ''.join(random.choices(string.digits, k=4))
    letters = ''.join(random.choices(string.ascii_uppercase, k=2))
    return f"IMG_{digits}{letters}"
def get_png_filename(save_dir):
    name = generate_random_name()
    filename = f"{name}.png"
    while (Path(save_dir)/filename).exists():
        name = generate_random_name()
        filename = f"{name}.png"
    return filename
def get_jpeg_filename(save_dir):
    name = generate_random_name()
    filename = f"{name}.jpg"
    while (Path(save_dir)/filename).exists():
        name = generate_random_name()
        filename = f"{name}.jpg"
    return filename
def png_to_jpeg_with_settings(image_path, save_dir, quality=100, use_444=True):
    try:
        img = Image.open(image_path)
        if img.mode in ('RGBA','LA','P'):
            bg = Image.new('RGB', img.size, (255,255,255))
            if img.mode == 'P': img = img.convert('RGBA')
            if img.mode == 'RGBA': bg.paste(img, mask=img.split()[-1])
            else: bg.paste(img)
            img = bg
        elif img.mode != 'RGB': img = img.convert('RGB')
        filename = get_jpeg_filename(Path(save_dir))
        jpeg_path = Path(save_dir) / filename
        subsampling = 0 if use_444 else 2
        img.save(jpeg_path, 'JPEG', quality=quality, optimize=False, subsampling=subsampling)
        return str(jpeg_path)
    except: return None

# ==================== UI 组件 ====================
class DraggablePreviewImage(QLabel):
    selected_changed = pyqtSignal(object, bool)
    right_clicked = pyqtSignal(object, QPoint)
    fission_requested = pyqtSignal(str, str)
    def __init__(self, img_path, parent=None):
        super().__init__(parent)
        self.img_path = img_path; self.selected = False
        self.setFixedSize(110,110)
        self.setStyleSheet("border:2px solid #ddd; background-color:#f5f5f5; border-radius:8px;")
        self.setAlignment(Qt.AlignCenter)
        self.drag_start_position = None
        self.setCursor(Qt.PointingHandCursor)
        self.setAcceptDrops(True)
        self.update_pixmap()
    def update_pixmap(self):
        try:
            pix = QPixmap(self.img_path)
            if not pix.isNull():
                self.setPixmap(pix.scaled(106,106, Qt.KeepAspectRatio, Qt.SmoothTransformation))
        except: pass
    def set_selected(self, selected):
        self.selected = selected
        if selected: self.setStyleSheet("border:3px solid #2196F3; background-color:#e3f2fd; border-radius:8px;")
        else: self.setStyleSheet("border:2px solid #ddd; background-color:#f5f5f5; border-radius:8px;")
    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.drag_start_position = event.pos()
            if event.modifiers() & Qt.ControlModifier:
                self.selected_changed.emit(self, not self.selected)
            else:
                self.selected_changed.emit(self, True)
            event.accept()
        elif event.button() == Qt.RightButton:
            self.right_clicked.emit(self, event.globalPos())
            event.accept()
        else: super().mousePressEvent(event)
    def mouseMoveEvent(self, event):
        if event.buttons() == Qt.LeftButton and self.drag_start_position:
            if (event.pos() - self.drag_start_position).manhattanLength() > QApplication.startDragDistance():
                drag = QDrag(self)
                mime_data = QMimeData()
                mime_data.setUrls([QUrl.fromLocalFile(self.img_path)])
                drag.setMimeData(mime_data)
                try:
                    pixmap = QPixmap(self.img_path).scaled(64,64, Qt.KeepAspectRatio, Qt.SmoothTransformation)
                    drag.setPixmap(pixmap)
                except: pass
                drag.setHotSpot(QPoint(32,32))
                drag.exec_(Qt.CopyAction)
                self.drag_start_position = None
        super().mouseMoveEvent(event)
    def mouseDoubleClickEvent(self, event):
        try:
            dlg = LargeImageDialog(self.img_path, self.window())
            dlg.exec_()
        except: pass
        super().mouseDoubleClickEvent(event)

class DragDropImageLabel(QLabel):
    imageDropped = pyqtSignal(int, str)
    rightClicked = pyqtSignal(int)
    def __init__(self, index, slot_name, slot_desc, parent=None):
        super().__init__(parent)
        self.index = index; self.slot_name = slot_name; self.slot_desc = slot_desc
        self.setFixedSize(85,85)
        self.setStyleSheet("border:2px dashed #aaa; background-color:#f5f5f5; border-radius:8px;")
        self.setAlignment(Qt.AlignCenter)
        self.setText(f"📷\n{slot_name}")
        self.setScaledContents(True)
        self.setAcceptDrops(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setToolTip(f"{slot_name}: {slot_desc}")
    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() or event.mimeData().hasImage():
            event.acceptProposedAction()
    def dropEvent(self, event):
        mime = event.mimeData()
        if mime.hasUrls():
            for url in mime.urls():
                path = url.toLocalFile()
                if path and os.path.isfile(path):
                    self.imageDropped.emit(self.index, path)
                    return
        elif mime.hasImage():
            pixmap = mime.imageData()
            if not pixmap.isNull():
                temp_dir = Path("temp_clipboard")
                temp_dir.mkdir(exist_ok=True)
                temp_path = temp_dir / f"drag_{self.index}_{int(time.time())}.png"
                pixmap.save(str(temp_path))
                self.imageDropped.emit(self.index, str(temp_path))
    def mouseDoubleClickEvent(self, event):
        win = self.window()
        if hasattr(win, 'upload_image'): win.upload_image(self.index)
    def mousePressEvent(self, event):
        if event.button() == Qt.RightButton:
            self.rightClicked.emit(self.index)
        else:
            self.setFocus()
            event.accept()
    def set_image(self, path):
        pix = QPixmap(path)
        if not pix.isNull():
            self.setPixmap(pix.scaled(83,83, Qt.KeepAspectRatio, Qt.SmoothTransformation))
            self.setStyleSheet("border:2px solid #4CAF50; background-color:#e8f5e9; border-radius:8px;")
            return True
        return False
    def clear_image(self):
        self.clear()
        self.setText(f"📷\n{self.slot_name}")
        self.setStyleSheet("border:2px dashed #aaa; background-color:#f5f5f5; border-radius:8px;")

class BatchPassphraseImageWidget(QLabel):
    rightClicked = pyqtSignal(str)
    def __init__(self, img_path, parent=None):
        super().__init__(parent)
        self.img_path = img_path
        self.setFixedSize(95,95)
        self.setStyleSheet("border:1px solid #ccc; border-radius:6px; background-color:#fafafa;")
        self.setScaledContents(False)
        self.setAlignment(Qt.AlignCenter)
        self.update_pixmap()
    def update_pixmap(self):
        pix = QPixmap(self.img_path)
        if not pix.isNull():
            self.setPixmap(pix.scaled(93,93, Qt.KeepAspectRatio, Qt.SmoothTransformation))
        else: self.clear()
    def mousePressEvent(self, event):
        if event.button() == Qt.RightButton:
            self.rightClicked.emit(self.img_path)
        event.accept()
    def mouseDoubleClickEvent(self, event):
        try:
            dlg = LargeImageDialog(self.img_path, self.window())
            dlg.exec_()
        except: pass

class PassphraseContainer(QWidget):
    imagesChanged = pyqtSignal(list)
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True); self.setFocusPolicy(Qt.StrongFocus)
        self.images = []
        self.main_layout = QVBoxLayout(self)
        self.main_layout.setContentsMargins(0,0,0,0); self.main_layout.setSpacing(6)
        self.grid_widget = QWidget()
        self.grid_widget.setMinimumHeight(105); self.grid_widget.setMaximumHeight(105)
        self.grid_layout = QGridLayout(self.grid_widget)
        self.grid_layout.setAlignment(Qt.AlignTop|Qt.AlignLeft)
        self.grid_layout.setSpacing(8); self.grid_layout.setContentsMargins(5,5,5,5)
        self.clear_btn = QPushButton("🗑️ 一键清空图片")
        self.clear_btn.setFixedWidth(120); self.clear_btn.setFixedHeight(30)
        self.clear_btn.setStyleSheet("QPushButton { background-color: #f0f0f0; color: #333; border: 1px solid #ddd; border-radius: 6px; } QPushButton:hover { background-color: #e0e0e0; }")
        self.clear_btn.clicked.connect(self.clear_all)
        self.main_layout.addWidget(self.grid_widget)
        self.main_layout.addWidget(self.clear_btn, 0, Qt.AlignLeft)
        self.setStyleSheet("background-color:#f8f8f8; border-radius:8px;")
        self.setMinimumHeight(155); self.setMaximumHeight(155)
    def add_image(self, path):
        if path and path not in self.images:
            self.images.append(path); self.refresh_grid(); self.imagesChanged.emit(self.images)
    def remove_image(self, path):
        if path in self.images:
            self.images.remove(path); self.refresh_grid(); self.imagesChanged.emit(self.images)
    def clear_all(self):
        self.images.clear(); self.refresh_grid(); self.imagesChanged.emit(self.images)
    def refresh_grid(self):
        for i in reversed(range(self.grid_layout.count())):
            w = self.grid_layout.itemAt(i).widget()
            if w: w.setParent(None)
        row = col = 0; max_cols = 6
        for path in self.images:
            w = BatchPassphraseImageWidget(path)
            w.rightClicked.connect(self.show_context_menu)
            self.grid_layout.addWidget(w, row, col)
            col += 1
            if col >= max_cols: col = 0; row += 1
    def show_context_menu(self, img_path):
        menu = QMenu(self)
        menu.setStyleSheet("QMenu { background-color: white; color: #333; border: 1px solid #ccc; } QMenu::item { padding: 5px 20px; } QMenu::item:selected { background-color: #2196F3; color: white; }")
        gen = QAction("单独生成", self); gen.triggered.connect(lambda: self.gen_single(img_path))
        delete = QAction("删除", self); delete.triggered.connect(lambda: self.remove_image(img_path))
        fission1_1 = QAction("1:1裂变(2张)", self); fission1_1.triggered.connect(lambda: self.fission_image_1v1(img_path))
        fission2_1 = QAction("2:1裂变(2张)", self); fission2_1.triggered.connect(lambda: self.fission_image(img_path, "2:1"))
        fission3_2 = QAction("3:2裂变(2张)", self); fission3_2.triggered.connect(lambda: self.fission_image(img_path, "3:2"))
        creative = QAction("创意无限", self); creative.triggered.connect(lambda: self.gen_creative(img_path))
        menu.addAction(gen); menu.addAction(fission1_1); menu.addAction(fission2_1); menu.addAction(fission3_2); menu.addAction(creative); menu.addAction(delete)
        menu.exec_(QCursor.pos())
    def gen_single(self, img_path):
        win = self.window()
        if hasattr(win, 'gen_single_passphrase'): win.gen_single_passphrase(img_path)
    def fission_image(self, img_path, size):
        win = self.window()
        if hasattr(win, 'fission_with_image_size'): win.fission_with_image_size(img_path, size)
    def fission_image_1v1(self, img_path):
        win = self.window()
        if hasattr(win, 'fission_1v1'): win.fission_1v1(img_path)
    def gen_creative(self, img_path):
        win = self.window()
        if hasattr(win, 'gen_creative_mode'): win.gen_creative_mode(img_path)
    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() or event.mimeData().hasImage():
            event.acceptProposedAction()
    def dropEvent(self, event):
        mime = event.mimeData()
        if mime.hasUrls():
            for url in mime.urls():
                path = url.toLocalFile()
                if path and os.path.isfile(path):
                    self.add_image(path)
            return
        if mime.hasImage():
            pixmap = mime.imageData()
            if not pixmap.isNull():
                temp_dir = Path("temp_clipboard"); temp_dir.mkdir(exist_ok=True)
                temp_path = temp_dir / f"drag_{int(time.time())}.png"
                pixmap.save(str(temp_path))
                self.add_image(str(temp_path))
    def mouseDoubleClickEvent(self, event):
        files, _ = QFileDialog.getOpenFileNames(self, "选择图片", "", "Images (*.png *.jpg *.jpeg)")
        for f in files: self.add_image(f)

class PreviewContainer(QWidget):
    selection_changed = pyqtSignal()
    key_pressed = pyqtSignal(int)
    def __init__(self, parent=None):
        super().__init__(parent)
        self.layout = QGridLayout(self)
        self.layout.setAlignment(Qt.AlignTop|Qt.AlignLeft)
        self.layout.setSpacing(8)
        self.image_widgets = []
        self.setAcceptDrops(True)
        self.setMinimumHeight(470)
        self.setFocusPolicy(Qt.StrongFocus)
        self.last_selected_index = -1
        self.max_preview_images = MAX_PREVIEW_IMAGES
    def keyPressEvent(self, event):
        if event.key() == Qt.Key_A and event.modifiers() & Qt.ControlModifier:
            for w in self.image_widgets:
                if not w.selected: w.set_selected(True)
            self.selection_changed.emit()
        elif event.key() == Qt.Key_Left: self.key_pressed.emit(Qt.Key_Left)
        elif event.key() == Qt.Key_Right: self.key_pressed.emit(Qt.Key_Right)
        else: super().keyPressEvent(event)
    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls(): event.acceptProposedAction()
    def dropEvent(self, event):
        mime = event.mimeData()
        if mime.hasUrls():
            for url in mime.urls():
                path = url.toLocalFile()
                if path and os.path.isfile(path):
                    win = self.window()
                    if hasattr(win, 'add_image_to_preview'): win.add_image_to_preview(path)
    def add_image(self, widget):
        self.image_widgets.append(widget)
        if len(self.image_widgets) > self.max_preview_images:
            old = self.image_widgets.pop(0); old.deleteLater()
        self.rearrange_grid()
        widget.selected_changed.connect(self.on_selection_changed)
    def remove_image(self, widget):
        if widget in self.image_widgets:
            self.image_widgets.remove(widget); widget.setParent(None); self.rearrange_grid()
    def clear_all(self):
        for w in self.image_widgets: w.deleteLater()
        self.image_widgets.clear(); self.rearrange_grid(); self.last_selected_index = -1
    def rearrange_grid(self):
        while self.layout.count():
            item = self.layout.takeAt(0)
            if item.widget(): item.widget().setParent(None)
        row = col = 0; max_cols = 6
        for w in self.image_widgets:
            self.layout.addWidget(w, row, col)
            col += 1
            if col >= max_cols: col = 0; row += 1
    def get_selected_widgets(self): return [w for w in self.image_widgets if w.selected]
    def get_all_widgets(self): return self.image_widgets.copy()
    def clear_all_selections(self):
        for w in self.image_widgets:
            if w.selected: w.set_selected(False)
        self.last_selected_index = -1; self.selection_changed.emit()
    def on_selection_changed(self, widget, selected):
        idx = self.image_widgets.index(widget) if widget in self.image_widgets else -1
        if selected:
            if QApplication.keyboardModifiers() & Qt.ShiftModifier and self.last_selected_index >=0 and idx >=0:
                start, end = min(self.last_selected_index, idx), max(self.last_selected_index, idx)
                for i in range(start, end+1):
                    if not self.image_widgets[i].selected: self.image_widgets[i].set_selected(True)
            elif not (QApplication.keyboardModifiers() & Qt.ControlModifier):
                for w in self.image_widgets:
                    if w != widget and w.selected: w.set_selected(False)
            self.last_selected_index = idx
        else:
            if idx == self.last_selected_index: self.last_selected_index = -1
        self.selection_changed.emit()
    def mousePressEvent(self, event):
        child = self.childAt(event.pos())
        if child is None or child == self: self.clear_all_selections()
        super().mousePressEvent(event)

class ResizableTextEdit(QTextEdit):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(60); self.setMaximumHeight(300)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.MinimumExpanding)
    def wheelEvent(self, event):
        if event.modifiers() & Qt.ControlModifier:
            delta = event.angleDelta().y()
            new_h = self.height() + (delta // 30)
            new_h = max(60, min(300, new_h))
            self.setFixedHeight(new_h)
        else: super().wheelEvent(event)

class LargeImageDialog(QDialog):
    def __init__(self, img_path, parent=None):
        super().__init__(parent)
        self.setWindowTitle("预览 - 滚轮缩放 | 空格/Esc关闭")
        self.setMinimumSize(400,300); self.resize(800,600)
        icon_path = resource_path("favicon.ico") if os.path.exists(resource_path("favicon.ico")) else resource_path("favicon (4).ico")
        if os.path.exists(icon_path): self.setWindowIcon(QIcon(icon_path))
        layout = QVBoxLayout()
        self.scroll = QScrollArea(); self.scroll.setWidgetResizable(True)
        self.label = QLabel(); self.label.setAlignment(Qt.AlignCenter)
        self.scroll.setWidget(self.label)
        layout.addWidget(self.scroll); self.setLayout(layout)
        self.pixmap = QPixmap(img_path); self.zoom = 1.0; self.update_display()
    def update_display(self):
        if not self.pixmap.isNull():
            scaled = self.pixmap.scaled(self.pixmap.size() * self.zoom, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            self.label.setPixmap(scaled)
    def wheelEvent(self, event):
        delta = event.angleDelta().y()
        self.zoom *= 1.1 if delta > 0 else 0.9
        self.zoom = max(0.1, min(5.0, self.zoom))
        self.update_display(); event.accept()
    def keyPressEvent(self, event):
        if event.key() in (Qt.Key_Space, Qt.Key_Escape): self.close()

class PromptTemplateDialog(QDialog):
    def __init__(self, templates, parent=None):
        super().__init__(parent)
        self.setWindowTitle("管理提示词模板")
        self.setMinimumSize(600,500); self.resize(700,550)
        self.templates = templates.copy(); self.init_ui()
    def init_ui(self):
        layout = QVBoxLayout()
        self.list_widget = QListWidget()
        self.list_widget.setWordWrap(True)
        self.list_widget.setStyleSheet("QListWidget { background-color: white; } QListWidget::item { padding: 5px; color: #333; } QListWidget::item:selected { background-color: #2196F3; color: white; } QListWidget::item:hover { background-color: #e3f2fd; color: #333; }")
        for i, tpl in enumerate(self.templates, 1):
            display = tpl[:50]+"..." if len(tpl)>50 else tpl
            item = QListWidgetItem(f"{i}. {display}")
            item.setData(Qt.UserRole, tpl); item.setToolTip(tpl)
            self.list_widget.addItem(item)
        layout.addWidget(QLabel("提示词列表:")); layout.addWidget(self.list_widget)
        btn_layout = QHBoxLayout()
        self.add_btn = QPushButton("添加"); self.edit_btn = QPushButton("编辑"); self.del_btn = QPushButton("删除"); self.save_btn = QPushButton("保存")
        btn_layout.addWidget(self.add_btn); btn_layout.addWidget(self.edit_btn); btn_layout.addWidget(self.del_btn); btn_layout.addStretch(); btn_layout.addWidget(self.save_btn)
        layout.addLayout(btn_layout); self.setLayout(layout)
        self.add_btn.clicked.connect(self.add_template); self.edit_btn.clicked.connect(self.edit_template); self.del_btn.clicked.connect(self.delete_template); self.save_btn.clicked.connect(self.save_and_close)
    def add_template(self):
        text, ok = QInputDialog.getMultiLineText(self, "添加", "提示词内容:")
        if ok and text: self.templates.append(text); self.refresh_list()
    def edit_template(self):
        item = self.list_widget.currentItem()
        if item:
            old = item.data(Qt.UserRole)
            text, ok = QInputDialog.getMultiLineText(self, "编辑", "提示词内容:", text=old)
            if ok and text:
                idx = self.list_widget.row(item)
                self.templates[idx] = text; self.refresh_list()
    def delete_template(self):
        item = self.list_widget.currentItem()
        if item:
            idx = self.list_widget.row(item)
            self.templates.pop(idx); self.refresh_list()
    def refresh_list(self):
        self.list_widget.clear()
        for i, tpl in enumerate(self.templates, 1):
            display = tpl[:50]+"..." if len(tpl)>50 else tpl
            item = QListWidgetItem(f"{i}. {display}")
            item.setData(Qt.UserRole, tpl); item.setToolTip(tpl)
            self.list_widget.addItem(item)
    def save_and_close(self): self.accept()

# ==================== 核心：支持快速切换端口的 ApiKeyDialog ====================
class ApiKeyDialog(QDialog):
    """执行参数与档位设置（AI 调用经平台桥，不在此配置密钥/端点）。"""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("执行参数设置")
        self.setMinimumWidth(480)
        self.init_ui()
    def init_ui(self):
        layout = QVBoxLayout()
        layout.addWidget(QLabel("档位（决定上游命中模型与计费）:"))
        self.tier_combo = QComboBox()
        for t in TIER_CHOICES:
            self.tier_combo.addItem(f"{t}（{'高级' if t == 'premium' else '快速'}）", t)
        cur_tier = app_settings.value("tier", DEFAULT_TIER, type=str)
        if cur_tier not in TIER_CHOICES: cur_tier = DEFAULT_TIER
        self.tier_combo.setCurrentIndex(TIER_CHOICES.index(cur_tier))
        layout.addWidget(self.tier_combo)
        info = QLabel("AI 调用经平台桥，按团队灵石计费，无需配置密钥。")
        info.setStyleSheet("color: #666; font-size: 11px;"); info.setWordWrap(True)
        layout.addWidget(info)
        layout.addWidget(QLabel("最大并发任务数:"))
        self.concurrency_spin = QSpinBox()
        self.concurrency_spin.setRange(1,30); self.concurrency_spin.setValue(get_max_concurrent())
        layout.addWidget(self.concurrency_spin)
        layout.addWidget(QLabel("单次请求超时 (秒，默认3000，≤3600):"))
        self.timeout_spin = QSpinBox()
        self.timeout_spin.setRange(30,3600); self.timeout_spin.setValue(get_timeout())
        layout.addWidget(self.timeout_spin)
        layout.addWidget(QLabel("最大重试次数:"))
        self.retry_spin = QSpinBox()
        self.retry_spin.setRange(1,20); self.retry_spin.setValue(get_retry_count())
        layout.addWidget(self.retry_spin)
        hint = QLabel("提示: 保存后部分参数需要重启程序生效（并发数、超时、重试）。")
        hint.setStyleSheet("color: #666; font-size: 11px;")
        layout.addWidget(hint)
        btn_layout = QHBoxLayout()
        self.save_btn = QPushButton("保存")
        self.save_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold; border-radius: 8px; padding: 6px 25px;")
        self.save_btn.clicked.connect(self.save_settings)
        cancel_btn = QPushButton("取消"); cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(self.save_btn); btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        self.setLayout(layout)
    def save_settings(self):
        app_settings.setValue("tier", self.tier_combo.currentData())
        app_settings.setValue("max_concurrent", self.concurrency_spin.value())
        app_settings.setValue("timeout", self.timeout_spin.value())
        app_settings.setValue("retry_count", self.retry_spin.value())
        APP_CONFIG["max_concurrent_tasks"] = self.concurrency_spin.value()
        APP_CONFIG["timeout_seconds"] = self.timeout_spin.value()
        APP_CONFIG["retry_count"] = self.retry_spin.value()
        QMessageBox.information(self, "提示", "设置已保存，部分参数需要重启程序生效。")
        self.accept()

# ==================== 核心API生成器（优化重试、限流、超时） ====================
class LocalAPIGenerator:
    RETRY_DELAY_BASE = 8
    _session = None
    _session_lock = QMutex()
    @classmethod
    def get_session(cls):
        with QMutexLocker(cls._session_lock):
            if cls._session is None:
                cls._session = requests.Session()
                adapter = requests.adapters.HTTPAdapter(pool_connections=50, pool_maxsize=50, max_retries=0)
                cls._session.mount('http://', adapter); cls._session.mount('https://', adapter)
            return cls._session
    @staticmethod
    def get_tier():
        tier = app_settings.value("tier", DEFAULT_TIER, type=str)
        return tier if tier in TIER_CHOICES else DEFAULT_TIER
    @staticmethod
    def get_size_str(size_ratio): return RATIO_STANDARD_SIZE.get(size_ratio, "1024x1024")
    @staticmethod
    def generate(task, progress_callback=None, image_ready_callback=None, ask_continue_callback=None, cancel_check=None):
        try:
            if not bridge_ready():
                raise Exception("未检测到平台桥环境变量，请在桌面客户端中运行本插件")
            max_retries = app_settings.value("retry_count", APP_CONFIG["retry_count"], type=int)
            timeout_sec = max(app_settings.value("timeout", APP_CONFIG["timeout_seconds"], type=int), DEFAULT_TIMEOUT)
            # 读超时硬上限：防止桥挂死时单次请求卡 3000s；正常链路不受影响（bridge 在 ≤600s 内回包）。
            read_timeout = min(timeout_sec, READ_TIMEOUT_CAP)
            tier = LocalAPIGenerator.get_tier()
            last_error = None
            for retry in range(max_retries):
                # 用户取消 / 总超时 watchdog 触发后，立即中止重试循环（否则仅置 _running=False 仍会继续重试）。
                if cancel_check and cancel_check():
                    raise InterruptedError("任务被取消或总超时，已中止")
                try:
                    if progress_callback: progress_callback(5 + retry*5)
                    image_paths = [p for p in task.images if p and os.path.exists(p)]
                    if not image_paths: raise Exception("没有有效的图片文件")
                    # 构建提示词
                    if task.mode == "换装":
                        if task.person_count > 1:
                            prompt = MULTI_PERSON_CHANGE_CLOTHES_TEMPLATE.format(person_count=task.person_count)
                            if task.prompt and task.prompt.strip(): prompt = f"{prompt} {task.prompt}"
                        else: prompt = f"{CHANGE_CLOTHES_PROMPT_TEMPLATE} {task.prompt}" if task.prompt else CHANGE_CLOTHES_PROMPT_TEMPLATE
                    elif task.mode == "换内搭":
                        if task.person_count > 1:
                            prompt = MULTI_PERSON_CHANGE_INNER_TEMPLATE.format(person_count=task.person_count)
                            if task.prompt and task.prompt.strip(): prompt = f"{prompt} {task.prompt}"
                        else: prompt = f"{CHANGE_INNER_PROMPT_TEMPLATE} {task.prompt}" if task.prompt else CHANGE_INNER_PROMPT_TEMPLATE
                    elif task.mode == "换头":
                        if task.person_count > 1:
                            prompt = MULTI_PERSON_CHANGE_FACE_TEMPLATE.format(person_count=task.person_count)
                            if task.prompt and task.prompt.strip(): prompt = f"{prompt} {task.prompt}"
                        else: prompt = f"{CHANGE_FACE_PROMPT_TEMPLATE} {task.prompt}" if task.prompt else CHANGE_FACE_PROMPT_TEMPLATE
                    elif task.mode == "裂变":
                        if task.person_count > 1:
                            prompt = MULTI_PERSON_FISSION_TEMPLATE.format(person_count=task.person_count)
                            if task.prompt and task.prompt.strip(): prompt = f"{prompt} {task.prompt}"
                        else: prompt = FISSION_PROMPT_TEMPLATE
                    elif task.mode == "创意无限": prompt = f"{CREATIVE_PROMPT_TEMPLATE} {task.prompt}" if task.prompt else CREATIVE_PROMPT_TEMPLATE
                    elif task.mode == "口令": prompt = task.prompt if task.prompt else DEFAULT_PASSPHRASE_PROMPT
                    elif task.mode == "批量换装":
                        base_prompt = CHANGE_CLOTHES_PROMPT_TEMPLATE
                        if task.prompt and task.prompt.strip(): prompt = f"{base_prompt} {task.prompt}"
                        else: prompt = base_prompt
                    else: prompt = task.prompt if task.prompt else "生成一张高质量的图片"
                    size_str = LocalAPIGenerator.get_size_str(task.size)
                    if progress_callback: progress_callback(30)
                    # 经平台桥 /image/edit（参考图 + prompt），转发到 relay 按团队灵石计费。
                    images_out = bridge_image_edit(prompt, image_paths, tier=tier, n=1, size=size_str, timeout=(30, read_timeout))
                    if progress_callback: progress_callback(70)
                    if not images_out:
                        if retry < max_retries-1:
                            wait_time = min(60, LocalAPIGenerator.RETRY_DELAY_BASE * (2 ** retry))
                            time.sleep(wait_time); continue
                        raise Exception("平台未返回编辑后的图片")
                    save_dir = Path(image_paths[0]).parent if image_paths[0] else DEFAULT_IMAGE_DIR
                    save_dir.mkdir(parents=True, exist_ok=True)
                    output_paths = []
                    for src in images_out:
                        try:
                            image_data = fetch_image_bytes(src)
                        except Exception as fe:
                            logging.error(f"下载结果图失败: {fe}"); continue
                        # 上游返回图按目标比例 center-crop 到精确像素（上游可能不认 size，客户端兜底保证比例）。
                        try:
                            pil = Image.open(io.BytesIO(image_data))
                            pil = _crop_to_ratio(pil, task.size)
                            buf = io.BytesIO()
                            pil.save(buf, format="PNG")
                            image_data = buf.getvalue()
                        except Exception as ce:
                            logging.error(f"结果图裁剪失败(原样保留): {ce}")
                        filename = get_png_filename(save_dir)
                        save_path = save_dir / filename
                        with open(save_path, 'wb') as f: f.write(image_data)
                        output_paths.append(str(save_path))
                        if image_ready_callback: image_ready_callback(str(save_path))
                    if output_paths:
                        task.output_paths = output_paths; task.status = "success"
                        if progress_callback: progress_callback(100)
                        return output_paths
                    else:
                        if retry < max_retries-1:
                            wait_time = min(60, LocalAPIGenerator.RETRY_DELAY_BASE * (2 ** retry))
                            time.sleep(wait_time); continue
                        raise Exception("API返回成功但未提取到图片数据")
                except requests.exceptions.Timeout:
                    print(f"[API超时] #{task.local_id} 单次请求超时（{read_timeout}秒），将重试")
                    if retry < max_retries-1:
                        wait_time = min(60, LocalAPIGenerator.RETRY_DELAY_BASE * (2 ** retry))
                        print(f"等待 {wait_time}s 后重试")
                        time.sleep(wait_time); continue
                    else: raise Exception(f"请求超时，已重试{max_retries}次仍失败")
                except BridgeError as e:
                    # 按错误类型决定重试：401/403/402 等不会自愈，立即失败，避免空等。
                    last_error = e
                    if bridge_error_is_retryable(e) and retry < max_retries-1:
                        wait_time = min(60, LocalAPIGenerator.RETRY_DELAY_BASE * (2 ** retry))
                        print(f"[API异常] #{task.local_id}: {e}，等待 {wait_time}s 后重试")
                        time.sleep(wait_time); continue
                    print(f"[API异常] #{task.local_id}: {e}（status={e.status}，不重试）")
                    raise
                except Exception as e:
                    last_error = e
                    if retry < max_retries-1:
                        wait_time = min(60, LocalAPIGenerator.RETRY_DELAY_BASE * (2 ** retry))
                        print(f"[API异常] #{task.local_id}: {e}，等待 {wait_time}s 后重试")
                        time.sleep(wait_time); continue
                    else: raise
            task.status = "failed"; task.error_msg = str(last_error) if last_error else "未知错误"
            raise Exception(task.error_msg)
        except Exception as e:
            logging.error(f"生成任务 {task.local_id} 崩溃: {str(e)}")
            logging.error(traceback.format_exc())
            raise

class ImageGenerator:
    @staticmethod
    def generate(task, progress_callback=None, image_ready_callback=None, ask_continue_callback=None, cancel_check=None):
        return LocalAPIGenerator.generate(task, progress_callback, image_ready_callback, ask_continue_callback, cancel_check=cancel_check)

class TaskWorker(QThread):
    progress_signal = pyqtSignal(int, int)
    finished_signal = pyqtSignal(int, list, str, float)
    image_ready_signal = pyqtSignal(str)
    ask_continue_signal = pyqtSignal(int)
    def __init__(self, task):
        super().__init__()
        self.task = task; self.start_time = None; self._watchdog = None; self._running = True
    def run(self):
        try:
            self.start_time = time.time()
            max_total = app_settings.value("max_total", APP_CONFIG["max_total_seconds"], type=int)
            # 总超时 watchdog：用 threading.Timer 而非 QTimer。原实现用 QTimer，但 QThread.run()
            # 未调用 self.exec()、无事件循环，QTimer 永不触发——on_total_timeout 从不执行，卡死任务
            # 无任何中止手段（已坐实）。threading.Timer 在独立 OS 线程触发，不受 Qt 事件循环影响。
            self._watchdog = threading.Timer(max(1, max_total), self.on_total_timeout)
            self._watchdog.daemon = True
            self._watchdog.start()
            def on_progress(p):
                if self._running: self.progress_signal.emit(self.task.local_id, p)
            def on_image_ready(path):
                if self._running: self.image_ready_signal.emit(path)
            # cancel_check 让重试循环在用户取消 / 总超时后能真正中止（仅置 _running=False 仍会继续重试）。
            outputs = ImageGenerator.generate(self.task, on_progress, on_image_ready,
                                              cancel_check=lambda: not self._running)
            if self._running:
                self._stop_watchdog()
                elapsed = time.time() - self.start_time
                self.finished_signal.emit(self.task.local_id, outputs, "", elapsed)
        except Exception as e:
            if self._running:
                self._stop_watchdog()
                elapsed = time.time() - self.start_time
                self.finished_signal.emit(self.task.local_id, [], str(e), elapsed)
    def on_total_timeout(self):
        # 总超时：强制中止（不再弹"是否继续"——原弹窗因 QTimer bug 从未出现，且对卡死无济于事）。
        # 置 _running=False 后，重试循环在下一轮顶部 cancel_check 处抛出 InterruptedError 结束任务。
        self._running = False
    def _stop_watchdog(self):
        if self._watchdog is not None:
            self._watchdog.cancel()
    def set_user_continue(self, cont):
        if not cont: self._running = False
    def stop(self):
        self._running = False
        self._stop_watchdog()
        self.quit(); self.wait(1000)

class TaskItem:
    def __init__(self, task_id, local_id, images, prompt, mode, resolution, size, num_outputs, person_count=1, save_dir=None):
        self.task_id = task_id; self.local_id = local_id; self.images = images; self.prompt = prompt; self.mode = mode; self.resolution = resolution; self.size = size; self.num_outputs = num_outputs; self.person_count = person_count; self.save_dir = save_dir
        self.status = "pending"; self.progress = 0; self.create_time = datetime.now(); self.output_paths = []; self.error_msg = ""; self.elapsed_seconds = 0; self._list_item = None; self._progress_bar = None

class TaskManager(QObject):
    task_updated_signal = pyqtSignal(int)
    task_finished_signal = pyqtSignal(int, list, str, float)
    image_ready_signal = pyqtSignal(str)
    def __init__(self):
        super().__init__()
        self.active_workers = []; self.pending_tasks = []; self.all_tasks = {}; self.task_order = []; self.next_local_id = 1; self.mutex = QMutex()
        self.load_tasks_from_db(); self.process_pending()
    def load_tasks_from_db(self):
        db_path = Path(APP_CONFIG["task_db"])
        if db_path.exists():
            try:
                with open(db_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                expire = datetime.now() - timedelta(days=APP_CONFIG["task_expire_days"])
                for d in data:
                    create_time = datetime.fromisoformat(d['create_time'])
                    if create_time > expire:
                        task = TaskItem(
                            d['task_id'], d['local_id'], d['images'], d['prompt'],
                            d['mode'], d['resolution'], d['size'], d['num_outputs'],
                            d.get('person_count',1), d.get('save_dir',None)
                        )
                        task.status = d['status']; task.progress = d['progress']; task.create_time = create_time
                        task.output_paths = d.get('output_paths', []); task.error_msg = d.get('error_msg', ''); task.elapsed_seconds = d.get('elapsed_seconds', 0)
                        self.all_tasks[task.local_id] = task; self.task_order.append(task.local_id)
                        if task.local_id >= self.next_local_id: self.next_local_id = task.local_id + 1
            except: pass
    def save_tasks_to_db(self):
        try:
            data = []
            for local_id in self.task_order:
                task = self.all_tasks[local_id]
                data.append({
                    'task_id': task.task_id, 'local_id': task.local_id, 'images': task.images,
                    'prompt': task.prompt, 'mode': task.mode, 'resolution': task.resolution,
                    'size': task.size, 'num_outputs': task.num_outputs, 'person_count': task.person_count,
                    'status': task.status, 'progress': task.progress, 'create_time': task.create_time.isoformat(),
                    'output_paths': task.output_paths, 'error_msg': task.error_msg,
                    'elapsed_seconds': task.elapsed_seconds, 'save_dir': task.save_dir
                })
            with open(APP_CONFIG["task_db"], 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except: pass
    def add_task(self, images, prompt, mode, resolution, size, num_outputs, person_count=1, save_dir=None):
        with QMutexLocker(self.mutex):
            local_id = self.next_local_id; self.next_local_id += 1
            task = TaskItem("", local_id, images, prompt, mode, resolution, size, num_outputs, person_count, save_dir)
            self.all_tasks[local_id] = task; self.task_order.append(local_id); self.pending_tasks.append(task)
            self.save_tasks_to_db(); self.task_updated_signal.emit(local_id)
            while len(self.task_order) > MAX_TASK_HISTORY:
                old_id = self.task_order.pop(0)
                if old_id in self.all_tasks: del self.all_tasks[old_id]
            QTimer.singleShot(10, self.process_pending); return local_id
    def add_fission_tasks(self, img_path, prompt, resolution, size, num_tasks, person_count=1, save_dir=None):
        ids = []
        with QMutexLocker(self.mutex):
            for i in range(num_tasks):
                local_id = self.next_local_id; self.next_local_id += 1
                task = TaskItem("", local_id, [img_path], prompt, "裂变", resolution, size, 1, person_count, save_dir)
                self.all_tasks[local_id] = task; self.task_order.append(local_id); self.pending_tasks.append(task); ids.append(local_id)
                time.sleep(random.uniform(0.05, 0.15))
            self.save_tasks_to_db()
            for tid in ids: self.task_updated_signal.emit(tid)
            QTimer.singleShot(10, self.process_pending); return ids
    def add_creative_task(self, img_path, prompt, resolution, size, save_dir=None):
        with QMutexLocker(self.mutex):
            local_id = self.next_local_id; self.next_local_id += 1
            task = TaskItem("", local_id, [img_path], prompt, "创意无限", resolution, size, 1, 1, save_dir)
            self.all_tasks[local_id] = task; self.task_order.append(local_id); self.pending_tasks.append(task)
            self.save_tasks_to_db(); self.task_updated_signal.emit(local_id)
            QTimer.singleShot(10, self.process_pending); return local_id
    def add_batch_clothes_tasks(self, clothes_list, model_list, prompt, resolution, size, save_dir=None):
        task_ids = []
        with QMutexLocker(self.mutex):
            for clothes_path in clothes_list:
                for model_path in model_list:
                    local_id = self.next_local_id; self.next_local_id += 1
                    images = [model_path, clothes_path]
                    task = TaskItem("", local_id, images, prompt, "换装", resolution, size, 1, 1, save_dir)
                    self.all_tasks[local_id] = task; self.task_order.append(local_id); self.pending_tasks.append(task); task_ids.append(local_id)
                    time.sleep(random.uniform(0.1, 0.2))
            self.save_tasks_to_db()
            for tid in task_ids: self.task_updated_signal.emit(tid)
            QTimer.singleShot(10, self.process_pending); return task_ids
    def retry_task(self, local_id):
        with QMutexLocker(self.mutex):
            if local_id not in self.all_tasks: return False
            task = self.all_tasks[local_id]
            if task.status != "failed": return False
            task.status = "pending"; task.progress = 0; task.error_msg = ""; task.elapsed_seconds = 0; task.output_paths = []
            self.pending_tasks.append(task)
            self.save_tasks_to_db(); self.task_updated_signal.emit(local_id)
            QTimer.singleShot(10, self.process_pending); return True
    def retry_multiple_tasks(self, local_ids):
        cnt = 0
        for lid in local_ids:
            if self.retry_task(lid): cnt += 1
        return cnt

    # ---------- 新增：强制取消所有任务 ----------
    def cancel_all_tasks(self):
        """强制取消所有正在运行和等待中的任务"""
        with QMutexLocker(self.mutex):
            # 终止所有活跃的工作线程
            for worker in self.active_workers:
                if worker.isRunning():
                    worker.stop()
                    if not worker.wait(500):
                        worker.terminate()
                        worker.wait(1000)
            self.active_workers.clear()

            # 清空待处理任务队列
            self.pending_tasks.clear()

            # 将所有未完成的任务状态标记为失败
            for task in self.all_tasks.values():
                if task.status not in ("success", "failed"):
                    task.status = "failed"
                    task.error_msg = "用户取消任务"

            self.save_tasks_to_db()

    # ---------- 原有方法 ----------
    def process_pending(self):
        max_concurrent = app_settings.value("max_concurrent", APP_CONFIG["max_concurrent_tasks"], type=int)
        with QMutexLocker(self.mutex):
            while len(self.active_workers) < max_concurrent and self.pending_tasks:
                task = self.pending_tasks.pop(0)
                if task.status == "pending":
                    # 优化：增加启动间隔 0.5~1.5 秒，防止瞬时突发
                    time.sleep(random.uniform(0.5, 1.5))
                    worker = TaskWorker(task)
                    worker.progress_signal.connect(self._on_progress, Qt.QueuedConnection)
                    worker.finished_signal.connect(self._on_finished, Qt.QueuedConnection)
                    worker.image_ready_signal.connect(self.image_ready_signal.emit, Qt.QueuedConnection)
                    worker.ask_continue_signal.connect(self._on_ask_continue, Qt.QueuedConnection)
                    worker.start()
                    self.active_workers.append(worker)
                    task.status = "uploading"
                    self.save_tasks_to_db(); self.task_updated_signal.emit(task.local_id)
    def _on_progress(self, local_id, progress):
        if local_id in self.all_tasks:
            task = self.all_tasks[local_id]
            task.progress = progress
            self.task_updated_signal.emit(local_id)
    def _on_finished(self, local_id, outputs, error_msg, elapsed):
        with QMutexLocker(self.mutex):
            for i, w in enumerate(self.active_workers):
                if w.task.local_id == local_id:
                    w.stop(); self.active_workers.pop(i); break
            task = self.all_tasks[local_id]
            task.elapsed_seconds = elapsed
            if error_msg:
                task.status = "failed"; task.error_msg = error_msg
            else:
                task.status = "success"; task.output_paths = outputs; task.progress = 100
            self.save_tasks_to_db()
            self.task_finished_signal.emit(local_id, outputs, error_msg, elapsed)
        QTimer.singleShot(10, lambda: self.task_updated_signal.emit(local_id))
        QTimer.singleShot(10, self.process_pending)
    def _on_ask_continue(self, local_id):
        max_total = app_settings.value("max_total", APP_CONFIG["max_total_seconds"], type=int)
        reply = QMessageBox.question(None, "任务超时", f"任务 #{local_id} 已超过 {max_total} 秒仍未完成，是否继续等待？",
                                     QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes)
        for w in self.active_workers:
            if w.task.local_id == local_id:
                w.set_user_continue(reply == QMessageBox.Yes); break
    def delete_task(self, local_id):
        with QMutexLocker(self.mutex):
            if local_id in self.all_tasks:
                del self.all_tasks[local_id]
                if local_id in self.task_order: self.task_order.remove(local_id)
                self.save_tasks_to_db(); self.task_updated_signal.emit(local_id)
    def clear_all_tasks(self):
        with QMutexLocker(self.mutex):
            self.active_workers.clear(); self.all_tasks.clear(); self.task_order.clear(); self.pending_tasks.clear(); self.next_local_id = 1
            self.save_tasks_to_db(); self.task_updated_signal.emit(-1)
    def get_failed_tasks(self):
        return [tid for tid, task in self.all_tasks.items() if task.status == "failed"]

class PngToJpegDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("PNG转JPEG - 无损转换设置"); self.setFixedWidth(450)
        self.quality = 100; self.use_444 = True; self.init_ui()
    def init_ui(self):
        layout = QVBoxLayout()
        layout.addWidget(QLabel("转换质量设置:"))
        qlayout = QHBoxLayout()
        qlayout.addWidget(QLabel("质量:"))
        self.slider = QSlider(Qt.Horizontal); self.slider.setRange(85,100); self.slider.setValue(100)
        self.slider.valueChanged.connect(self.on_quality)
        qlayout.addWidget(self.slider)
        self.quality_label = QLabel("100%"); self.quality_label.setFixedWidth(40)
        qlayout.addWidget(self.quality_label)
        layout.addLayout(qlayout)
        self.sub_check = QCheckBox("使用最高色彩精度 (4:4:4 无色度抽样) - 推荐")
        self.sub_check.setChecked(True); layout.addWidget(self.sub_check)
        info = QLabel("说明:\n• 质量100%: 最高画质，文件较大\n• 4:4:4色彩: 完整保留色彩信息\n• PNG原图2.1MB转JPEG约1.9-2.0MB（接近无损）")
        info.setStyleSheet("color: #666; font-size: 11px; margin-top: 10px;"); info.setWordWrap(True)
        layout.addWidget(info)
        btn_layout = QHBoxLayout()
        self.convert_btn = QPushButton("开始转换"); self.convert_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold;")
        self.convert_btn.clicked.connect(self.accept)
        cancel = QPushButton("取消"); cancel.clicked.connect(self.reject)
        btn_layout.addWidget(self.convert_btn); btn_layout.addWidget(cancel)
        layout.addLayout(btn_layout); self.setLayout(layout)
    def on_quality(self, v): self.quality = v; self.quality_label.setText(f"{v}%")
    def get_settings(self): return self.quality, self.sub_check.isChecked()

class MultiPersonDialog(QDialog):
    def __init__(self, mode="换装", default_person_count=2, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"多人{mode}设置"); self.setFixedWidth(500)
        self.mode = mode; self.result_prompt = ""; self.result_person_count = default_person_count
        self.init_ui(default_person_count)
    def init_ui(self, default_person_count):
        layout = QVBoxLayout()
        person_layout = QHBoxLayout()
        person_layout.addWidget(QLabel("画面中的人物数量 (2-8人):"))
        self.spin = QSpinBox(); self.spin.setRange(2,8); self.spin.setValue(default_person_count); self.spin.setFixedWidth(80)
        person_layout.addWidget(self.spin); person_layout.addStretch()
        layout.addLayout(person_layout)
        layout.addWidget(QLabel("提示词 (可编辑修改):"))
        self.prompt_edit = QTextEdit(); self.prompt_edit.setMinimumHeight(200)
        if self.mode == "换装": default_prompt = MULTI_PERSON_CHANGE_CLOTHES_TEMPLATE.format(person_count=default_person_count)
        elif self.mode == "换内搭": default_prompt = MULTI_PERSON_CHANGE_INNER_TEMPLATE.format(person_count=default_person_count)
        elif self.mode == "换头": default_prompt = MULTI_PERSON_CHANGE_FACE_TEMPLATE.format(person_count=default_person_count)
        else: default_prompt = MULTI_PERSON_FISSION_TEMPLATE.format(person_count=default_person_count)
        self.prompt_edit.setText(default_prompt)
        layout.addWidget(self.prompt_edit)
        btn_layout = QHBoxLayout()
        ok_btn = QPushButton("确认并生成"); ok_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold;")
        ok_btn.clicked.connect(self.accept)
        cancel = QPushButton("取消"); cancel.clicked.connect(self.reject)
        btn_layout.addWidget(ok_btn); btn_layout.addWidget(cancel)
        layout.addLayout(btn_layout); self.setLayout(layout)
    def accept(self):
        self.result_person_count = self.spin.value()
        prompt = self.prompt_edit.toPlainText()
        self.result_prompt = prompt.replace("{person_count}", str(self.result_person_count))
        super().accept()
    def get_result(self): return self.result_person_count, self.result_prompt

class BatchImageContainer(QWidget):
    imagesChanged = pyqtSignal(list)
    max_images = 20
    def __init__(self, title, max_images, width, parent=None):
        super().__init__(parent)
        self.max_images = max_images; self.images = []; self.pending_add_paths = []
        self.update_timer = QTimer(); self.update_timer.setSingleShot(True); self.update_timer.timeout.connect(self._flush_pending)
        self.setAcceptDrops(True); self.setFocusPolicy(Qt.StrongFocus); self.setFixedWidth(width)
        self.setMinimumHeight(100); self.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.MinimumExpanding)
        main_layout = QVBoxLayout(self); main_layout.setContentsMargins(0,0,0,0); main_layout.setSpacing(4)
        title_layout = QHBoxLayout()
        self.title_label = QLabel(title); self.title_label.setStyleSheet("font-weight: bold; font-size: 12px; color: #333;")
        title_layout.addWidget(self.title_label); title_layout.addStretch()
        self.count_label = QLabel(f"0/{self.max_images}"); self.count_label.setStyleSheet("color: #666; font-size: 11px;")
        title_layout.addWidget(self.count_label)
        main_layout.addLayout(title_layout)
        self.scroll_area = QScrollArea(); self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded); self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.scroll_area.setStyleSheet("QScrollArea { border: none; background-color: transparent; }")
        self.scroll_area.setMinimumHeight(80)
        self.grid_widget = QWidget(); self.grid_layout = QGridLayout(self.grid_widget)
        self.grid_layout.setAlignment(Qt.AlignTop|Qt.AlignLeft); self.grid_layout.setSpacing(8); self.grid_layout.setContentsMargins(5,5,5,5)
        self.scroll_area.setWidget(self.grid_widget); main_layout.addWidget(self.scroll_area)
        btn_layout = QHBoxLayout()
        self.clear_btn = QPushButton("清空"); self.clear_btn.setFixedSize(55,25); self.clear_btn.clicked.connect(self.clear_all)
        btn_layout.addWidget(self.clear_btn); btn_layout.addStretch()
        main_layout.addLayout(btn_layout)
        self.setStyleSheet("background-color: #f8f8f8; border-radius: 8px; padding: 4px;")
    def add_image(self, path):
        if not path: return
        if path in self.images: return
        if len(self.images) >= self.max_images:
            QMessageBox.information(self, "提示", f"最多只能添加{self.max_images}张图片"); return
        self.pending_add_paths.append(path); self.update_timer.start(50)
    def _flush_pending(self):
        if not self.pending_add_paths: return
        added = 0
        for path in self.pending_add_paths:
            if path not in self.images and len(self.images) < self.max_images:
                self.images.append(path); added += 1
        self.pending_add_paths.clear()
        if added > 0: self.refresh_grid(); self.imagesChanged.emit(self.images)
    def remove_image(self, path):
        if path in self.images: self.images.remove(path); self.refresh_grid(); self.imagesChanged.emit(self.images)
    def clear_all(self):
        self.images.clear(); self.pending_add_paths.clear(); self.update_timer.stop(); self.refresh_grid(); self.imagesChanged.emit(self.images)
    def refresh_grid(self):
        for i in reversed(range(self.grid_layout.count())):
            w = self.grid_layout.itemAt(i).widget()
            if w: w.setParent(None)
        row = col = 0; max_cols = 6
        for path in self.images:
            w = BatchPassphraseImageWidget(path)
            w.rightClicked.connect(lambda p=path: self.show_context_menu(p))
            self.grid_layout.addWidget(w, row, col)
            col += 1
            if col >= max_cols: col = 0; row += 1
        self.count_label.setText(f"{len(self.images)}/{self.max_images}")
    def show_context_menu(self, img_path):
        menu = QMenu(self)
        menu.setStyleSheet("QMenu { background-color: white; color: #333; border: 1px solid #ccc; } QMenu::item { padding: 5px 20px; } QMenu::item:selected { background-color: #2196F3; color: white; }")
        delete_action = QAction("删除", self); delete_action.triggered.connect(lambda: self.remove_image(img_path))
        menu.addAction(delete_action); menu.exec_(QCursor.pos())
    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() or event.mimeData().hasImage(): event.acceptProposedAction()
    def dropEvent(self, event):
        mime = event.mimeData()
        if mime.hasUrls():
            for url in mime.urls():
                path = url.toLocalFile()
                if path and os.path.isfile(path): self.add_image(path)
            return
        if mime.hasImage():
            pixmap = mime.imageData()
            if not pixmap.isNull():
                temp_dir = Path("temp_clipboard"); temp_dir.mkdir(exist_ok=True)
                temp_path = temp_dir / f"batch_{int(time.time())}.png"
                pixmap.save(str(temp_path)); self.add_image(str(temp_path))
    def mouseDoubleClickEvent(self, event):
        files, _ = QFileDialog.getOpenFileNames(self, "选择图片", "", "Images (*.png *.jpg *.jpeg)")
        for f in files: self.add_image(f)

class ClothesContainer(BatchImageContainer):
    def __init__(self, parent=None): super().__init__("👕 服装图区 (最多3张)", 3, 415, parent)
class ModelContainer(BatchImageContainer):
    def __init__(self, parent=None): super().__init__("💃 模特姿态图区 (最多20张)", 20, 595, parent)

# ==================== 主窗口 ====================
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"AI换装批量版 (并发{get_max_concurrent()} | 超时{get_timeout()}s | 重试{get_retry_count()}次)")
        self.setMinimumSize(1200,800); self.resize(1500,900)
        icon_path = resource_path("favicon.ico") if os.path.exists(resource_path("favicon.ico")) else resource_path("favicon (4).ico")
        if os.path.exists(icon_path): self.setWindowIcon(QIcon(icon_path))
        self.task_manager = TaskManager()
        self.task_manager.task_updated_signal.connect(self.on_task_updated, Qt.QueuedConnection)
        self.task_manager.task_finished_signal.connect(self.on_task_finished, Qt.QueuedConnection)
        self.task_manager.image_ready_signal.connect(self.on_image_ready, Qt.QueuedConnection)
        self.image_paths = ["","","",""]; self.image_labels = []
        self.passphrase_mode = False; self.batch_mode = False
        self.prompt_templates = self.load_prompt_templates()
        self.preview_container = None
        self._generating = False; self._generate_lock = False
        self.passphrase_container = None
        self.naming_prefix = "1"; self.task_items = {}; self.selected_task_ids = set()
        self.pending_images = set(); self.pending_timer = QTimer(); self.pending_timer.setSingleShot(True); self.pending_timer.timeout.connect(self.flush_pending_images)
        self.upscale_worker = None
        self._update_timer = QTimer(); self._update_timer.setSingleShot(True); self._update_timer.timeout.connect(self._apply_pending_updates)
        self._pending_updates = set()
        self._mem_timer = QTimer(); self._mem_timer.timeout.connect(self._check_memory); self._mem_timer.start(30000)
        DEFAULT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
        APP_CONFIG["auto_save_path"] = str(DEFAULT_IMAGE_DIR)
        self.init_ui()
        self.restore_preview_from_tasks()
        self.refresh_task_list(); self.update_api_status_label()
        if APP_CONFIG["auto_save_path"]: self.auto_save_path_edit.setText(APP_CONFIG["auto_save_path"])
        self.switch_mode(0)
        print(f"[初始化] 档位: {LocalAPIGenerator.get_tier()} | 并发: {get_max_concurrent()} | 超时: {get_timeout()}s | 重试: {get_retry_count()}次")

    def _check_memory(self):
        if check_memory_and_cleanup(): self.statusBar().showMessage("内存清理完成", 3000)

    def start_upscale(self):
        selected = self.preview_container.get_selected_widgets()
        if not selected: QMessageBox.information(self, "提示", "请先在预览区选中要放大的图片"); return
        res, ok = QInputDialog.getItem(self, "选择分辨率", "请选择目标分辨率：", ["2K","4K","8K"], 0, False)
        if not ok: return
        paths = [w.img_path for w in selected]
        self._do_upscale(paths, res)
    def _do_upscale(self, paths, resolution):
        self.upscale_worker = UpscaleWorker(paths, resolution, gentle=False)
        self.upscale_worker.progress_signal.connect(self.on_upscale_progress)
        self.upscale_worker.finished_signal.connect(self.on_upscale_finished)
        self.upscale_worker.error_signal.connect(self.on_upscale_error)
        self.upscale_worker.start()
        self.statusBar().showMessage(f"🔍 正在放大 {len(paths)} 张图片到 {resolution} ...")
    def on_upscale_progress(self, current, total): self.statusBar().showMessage(f"🔍 放大进度: {current}/{total}")
    def on_upscale_finished(self, output_paths):
        for p in output_paths: self.add_image_to_preview(p)
        self.statusBar().showMessage(f"✅ 放大完成，生成 {len(output_paths)} 张图片", 5000)
        self.upscale_worker = None; gc.collect()
    def on_upscale_error(self, err): QMessageBox.warning(self, "放大错误", err); self.statusBar().showMessage("❌ 放大出错", 3000); self.upscale_worker = None

    def update_api_status_label(self):
        tier = app_settings.value("tier", DEFAULT_TIER, type=str)
        if tier not in TIER_CHOICES: tier = DEFAULT_TIER
        self.api_status_label.setText(f"🔌 档位: {tier} | 并发: {get_max_concurrent()} | 超时: {get_timeout()}s | 重试: {get_retry_count()}次 | 经平台桥·按灵石计费")

    def restore_preview_from_tasks(self):
        all_paths = set()
        for local_id in self.task_manager.task_order:
            task = self.task_manager.all_tasks.get(local_id)
            if task and task.status == "success":
                for p in task.output_paths:
                    if os.path.exists(p): all_paths.add(p)
        for p in all_paths: self.add_image_to_preview(p)

    def closeEvent(self, event):
        print("[关闭] 正在取消所有任务并清理缓存...")
        try:
            # 强制取消所有任务
            if hasattr(self, 'task_manager'):
                self.task_manager.cancel_all_tasks()

            # 停止高清修复线程
            if self.upscale_worker and self.upscale_worker.isRunning():
                self.upscale_worker.cancel()
                self.upscale_worker.wait(1000)

            # 清理临时文件
            temp_dirs = ["temp_clipboard", "cache", "temp_drag", "temp"]
            for d in temp_dirs:
                p = Path(d)
                if p.exists():
                    shutil.rmtree(p, ignore_errors=True)
            for f in Path(".").glob("temp_*.png"):
                f.unlink()
            for f in Path(".").glob("drag_*.png"):
                f.unlink()
            gc.collect()
            event.accept()
        except Exception as e:
            print(f"[关闭] 异常: {e}")
            event.accept()

    def load_prompt_templates(self):
        db = Path(APP_CONFIG["prompt_templates_db"])
        if db.exists():
            try:
                with open(db, 'r', encoding='utf-8') as f: return json.load(f)
            except: return APP_CONFIG["default_prompt_templates"].copy()
        return APP_CONFIG["default_prompt_templates"].copy()
    def save_prompt_templates(self, templates):
        with open(APP_CONFIG["prompt_templates_db"], 'w', encoding='utf-8') as f:
            json.dump(templates, f, indent=2, ensure_ascii=False)

    def update_size_combo(self):
        res = self.resolution_combo.currentText()
        ratios = RESOLUTION_SUPPORTED_RATIOS.get(res, RESOLUTION_SUPPORTED_RATIOS["1K"])
        cur = self.size_combo.currentText()
        self.size_combo.blockSignals(True); self.size_combo.clear(); self.size_combo.addItems(ratios)
        if cur in ratios: self.size_combo.setCurrentText(cur)
        else: self.size_combo.setCurrentIndex(0)
        self.size_combo.blockSignals(False)

    def upload_image(self, idx):
        path, _ = QFileDialog.getOpenFileName(self, "选择图片", "", "Images (*.png *.jpg *.jpeg)")
        if path: self.image_paths[idx] = path; self.image_labels[idx].set_image(path)

    def get_save_dir(self, source_path=None):
        if source_path and os.path.exists(source_path): return str(Path(source_path).parent)
        return str(DEFAULT_IMAGE_DIR)

    def fission_1v1(self, img_path):
        if not img_path or self._generating: return
        prompt = FISSION_PROMPT_1V1; save_dir = self.get_save_dir(img_path); person = self.person_spin.value()
        self.task_manager.add_fission_tasks(img_path, prompt, "2K", "1:1", 2, person, save_dir)
        self.refresh_task_list()
    def fission_with_image_size(self, img_path, size, num=2):
        if not img_path or self._generating: return
        prompt = FISSION_PROMPT_TEMPLATE; save_dir = self.get_save_dir(img_path); person = self.person_spin.value()
        self.task_manager.add_fission_tasks(img_path, prompt, "2K", size, num, person, save_dir)
        self.refresh_task_list()
    def gen_creative_mode(self, img_path):
        if not img_path or self._generating: return
        prompt, ok = QInputDialog.getMultiLineText(self, "创意无限", "请输入创意描述：", "生成创意图片，高质量，细节丰富")
        if ok and prompt:
            save_dir = self.get_save_dir(img_path)
            self.task_manager.add_creative_task(img_path, prompt, "2K", self.size_combo.currentText(), save_dir)
            self.refresh_task_list()

    def png_to_jpeg_conversion(self):
        selected = self.preview_container.get_selected_widgets() if self.preview_container else []
        if not selected: QMessageBox.warning(self, "警告", "请先在预览区选中图片"); return
        pngs = [w for w in selected if w.img_path.lower().endswith('.png')]
        if not pngs: QMessageBox.information(self, "提示", "选中的图片中没有PNG格式"); return
        dlg = PngToJpegDialog(self)
        if dlg.exec_() != QDialog.Accepted: return
        qual, use444 = dlg.get_settings()
        converted = 0; total_orig = total_new = 0
        for w in pngs:
            orig = os.path.getsize(w.img_path); total_orig += orig
            save_dir = Path(w.img_path).parent
            jpeg = png_to_jpeg_with_settings(w.img_path, save_dir, qual, use444)
            if jpeg:
                total_new += os.path.getsize(jpeg)
                self.add_image_to_preview(jpeg); converted += 1
        if converted:
            ratio = (1 - total_new/total_orig)*100
            QMessageBox.information(self, "完成", f"已转换 {converted} 张图片\n原大小: {total_orig/1024:.1f}KB\n新大小: {total_new/1024:.1f}KB\n压缩率: {ratio:.1f}%")

    def rename_selected_images(self):
        selected = self.preview_container.get_selected_widgets() if self.preview_container else []
        if not selected: QMessageBox.information(self, "提示", "请先在预览区选中图片"); return
        prefix, ok = QInputDialog.getText(self, "批量重命名", "请输入命名前缀:", text="IMG")
        if not ok or not prefix: return
        cnt = 0
        for w in selected:
            old = w.img_path; dirname = os.path.dirname(old); ext = os.path.splitext(old)[1]
            suffix = generate_random_name().replace("IMG_", "")
            new_name = f"{prefix}_{suffix}{ext}"; new_path = os.path.join(dirname, new_name)
            while os.path.exists(new_path):
                suffix = generate_random_name().replace("IMG_", "")
                new_name = f"{prefix}_{suffix}{ext}"; new_path = os.path.join(dirname, new_name)
            shutil.copy2(old, new_path); self.add_image_to_preview(new_path); cnt += 1
        QMessageBox.information(self, "完成", f"已重命名 {cnt} 张图片")

    def open_api_settings(self):
        dlg = ApiKeyDialog(self)
        if dlg.exec_() == QDialog.Accepted:
            self.update_api_status_label()
            self.setWindowTitle(f"AI换装批量版 (并发{get_max_concurrent()} | 超时{get_timeout()}s | 重试{get_retry_count()}次)")

    def open_multi_person_change(self, mode):
        cur = self.person_spin.value()
        dlg = MultiPersonDialog(mode, cur, self)
        if dlg.exec_() == QDialog.Accepted:
            pc, prompt = dlg.get_result()
            self.person_spin.setValue(pc); self.keyword_input.setText(prompt); QTimer.singleShot(100, self.generate_action)
    def open_multi_person_fission(self):
        cur = self.person_spin.value()
        dlg = MultiPersonDialog("裂变", cur, self)
        if dlg.exec_() == QDialog.Accepted:
            pc, prompt = dlg.get_result()
            self.person_spin.setValue(pc); self.keyword_input.setText(prompt); QTimer.singleShot(100, self.generate_action)

    def init_ui(self):
        self.setStyleSheet("""
            QMainWindow { background-color: #f3f4f6; }
            QFrame, QGroupBox { border-radius: 12px; }
            QTextEdit, QLineEdit, QListWidget, QTreeWidget { border-radius: 10px; }
            QPushButton { background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 7px 14px; color: #374151; font-weight: 500; }
            QPushButton:hover { background-color: #f9fafb; border-color: #d1d5db; }
            QPushButton:pressed { background-color: #f3f4f6; }
            QPushButton:disabled { color: #9ca3af; background-color: #f3f4f6; border-color: #e5e7eb; }
            QComboBox { border: 1px solid #e5e7eb; padding: 6px 10px; border-radius: 8px; background-color: #ffffff; color: #374151; }
            QComboBox:hover { border-color: #d1d5db; }
            QComboBox QAbstractItemView { border: 1px solid #e5e7eb; border-radius: 6px; background-color: #ffffff; selection-background-color: #3b82f6; selection-color: #ffffff; outline: none; padding: 2px; }
            QSpinBox { border: 1px solid #e5e7eb; padding: 5px 6px; border-radius: 8px; background-color: #ffffff; color: #374151; }
            QTextEdit, QLineEdit { border: 1px solid #e5e7eb; padding: 7px; border-radius: 10px; background-color: #ffffff; color: #374151; selection-background-color: #3b82f6; selection-color: #ffffff; }
            QTextEdit:focus, QLineEdit:focus { border: 1px solid #3b82f6; }
            QLabel { color: #374151; }
            QListWidget { border: 1px solid #e5e7eb; background-color: #ffffff; outline: none; }
            QListWidget::item { padding: 0px; margin: 2px; border-radius: 6px; }
            QListWidget::item:selected { background-color: #dbeafe; color: #1e40af; }
            QListWidget::item:hover { background-color: #eff6ff; }
            QProgressBar { border: none; background-color: #e5e7eb; border-radius: 3px; }
            QProgressBar::chunk { background-color: #3b82f6; border-radius: 3px; }
            QSplitter::handle { background-color: #e5e7eb; border-radius: 2px; }
            QMenu { background-color: #ffffff; color: #374151; border: 1px solid #e5e7eb; border-radius: 8px; padding: 4px; }
            QMenu::item { padding: 6px 24px; border-radius: 6px; }
            QMenu::item:selected { background-color: #3b82f6; color: #ffffff; }
            QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
            QScrollBar::handle:vertical { background: #d1d5db; border-radius: 4px; min-height: 24px; }
            QScrollBar::handle:vertical:hover { background: #9ca3af; }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
            QScrollBar:horizontal { background: transparent; height: 10px; margin: 2px; }
            QScrollBar::handle:horizontal { background: #d1d5db; border-radius: 4px; min-width: 24px; }
            QScrollBar::handle:horizontal:hover { background: #9ca3af; }
            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }
            QToolTip { background-color: #1f2937; color: #ffffff; border: none; border-radius: 6px; padding: 4px 8px; }
        """)

        main_splitter = QSplitter(Qt.Horizontal)
        main_splitter.setHandleWidth(4); self.setCentralWidget(main_splitter)

        left = QWidget(); left.setMinimumWidth(180)
        left_layout = QVBoxLayout(left); left_layout.setContentsMargins(5,5,5,5)

        title_layout = QHBoxLayout()
        left_label = QLabel("📋 任务列表 (Ctrl/Shift多选)"); left_label.setStyleSheet("font-weight: bold; font-size: 14px;")
        title_layout.addWidget(left_label); title_layout.addStretch()
        api_btn = QPushButton("🔑 API设置"); api_btn.setFixedWidth(90); api_btn.setStyleSheet("background-color: #607D8B; color: white; border-radius: 6px;")
        api_btn.clicked.connect(self.open_api_settings)
        title_layout.addWidget(api_btn); left_layout.addLayout(title_layout)

        self.api_status_label = QLabel(); self.api_status_label.setStyleSheet("color: #FF9800; font-size: 11px;")
        left_layout.addWidget(self.api_status_label)

        self.task_list_widget = QListWidget(); self.task_list_widget.setWordWrap(True)
        self.task_list_widget.setSelectionMode(QListWidget.ExtendedSelection)
        self.task_list_widget.setContextMenuPolicy(Qt.CustomContextMenu)
        self.task_list_widget.customContextMenuRequested.connect(self.on_task_list_right_click)
        self.task_list_widget.itemSelectionChanged.connect(self.on_task_selection_changed)
        left_layout.addWidget(self.task_list_widget)

        btn_layout = QHBoxLayout()
        clear_btn = QPushButton("清空所有"); clear_btn.clicked.connect(self.clear_all_tasks)
        refresh_btn = QPushButton("刷新"); refresh_btn.clicked.connect(self.refresh_task_list)
        reset_btn = QPushButton("重置布局"); reset_btn.clicked.connect(self.reset_splitter)
        btn_layout.addWidget(clear_btn); btn_layout.addWidget(refresh_btn); btn_layout.addWidget(reset_btn)
        left_layout.addLayout(btn_layout)
        main_splitter.addWidget(left)

        right = QWidget(); right.setMinimumWidth(400)
        right_layout = QVBoxLayout(right); right_layout.setContentsMargins(0,0,0,0); right_layout.setSpacing(5)

        vertical_splitter = QSplitter(Qt.Vertical); vertical_splitter.setHandleWidth(4); vertical_splitter.setChildrenCollapsible(False)

        preview_widget = QWidget()
        preview_layout = QVBoxLayout(preview_widget); preview_layout.setContentsMargins(0,0,0,0)

        toolbar = QHBoxLayout()
        png2jpg = QPushButton("PNG转JPEG"); png2jpg.setFixedWidth(90); png2jpg.setStyleSheet("background-color: #9C27B0; color: white; font-weight: bold;")
        png2jpg.clicked.connect(self.png_to_jpeg_conversion)
        self.select_all_btn = QPushButton("全选"); self.select_all_btn.clicked.connect(self.select_all_previews)
        self.save_selected_btn = QPushButton("另存选中"); self.save_selected_btn.clicked.connect(self.save_selected_images)
        self.del_selected_btn = QPushButton("删除选中"); self.del_selected_btn.clicked.connect(self.delete_selected_previews)
        self.clear_all_previews_btn = QPushButton("清空预览"); self.clear_all_previews_btn.clicked.connect(self.clear_all_previews)
        self.upscale_btn = QPushButton("2K4K修复(选中)"); self.upscale_btn.setFixedWidth(110); self.upscale_btn.setStyleSheet("background-color: #2196F3; color: white; font-weight: bold;")
        self.upscale_btn.clicked.connect(self.start_upscale)

        naming_label = QLabel("命名:")
        self.naming_edit = QLineEdit(); self.naming_edit.setPlaceholderText("前缀"); self.naming_edit.setFixedWidth(100)
        rename_btn = QPushButton("一键命名"); rename_btn.setFixedWidth(80); rename_btn.clicked.connect(self.rename_selected_images)

        toolbar.addWidget(png2jpg); toolbar.addWidget(self.select_all_btn); toolbar.addWidget(self.save_selected_btn)
        toolbar.addWidget(self.del_selected_btn); toolbar.addWidget(self.clear_all_previews_btn); toolbar.addWidget(self.upscale_btn)
        toolbar.addStretch(); toolbar.addWidget(naming_label); toolbar.addWidget(self.naming_edit); toolbar.addWidget(rename_btn)
        preview_layout.addLayout(toolbar)

        self.preview_scroll = QScrollArea(); self.preview_scroll.setWidgetResizable(True)
        self.preview_container = PreviewContainer()
        self.preview_container.selection_changed.connect(self.on_preview_selection_changed)
        self.preview_container.key_pressed.connect(self.on_preview_key_pressed)
        self.preview_scroll.setWidget(self.preview_container)
        preview_layout.addWidget(self.preview_scroll, 1)
        vertical_splitter.addWidget(preview_widget)

        control_panel = QFrame(); control_panel.setObjectName("ControlPanel")
        control_panel.setStyleSheet("#ControlPanel { background-color: white; border-radius: 15px; margin: 5px; }")
        ctrl_layout = QVBoxLayout(control_panel); ctrl_layout.setContentsMargins(12,6,12,6); ctrl_layout.setSpacing(4)

        prompt_header = QHBoxLayout()
        self.prompt_toggle_btn = QToolButton(); self.prompt_toggle_btn.setText("▼ 提示词库"); self.prompt_toggle_btn.setCheckable(True); self.prompt_toggle_btn.setChecked(True)
        self.prompt_toggle_btn.clicked.connect(self.toggle_prompt_area)
        prompt_header.addWidget(self.prompt_toggle_btn); prompt_header.addStretch()
        manage_tpl_btn = QPushButton("管理模板"); manage_tpl_btn.setFixedWidth(80); manage_tpl_btn.clicked.connect(self.manage_templates)
        prompt_header.addWidget(manage_tpl_btn)
        ctrl_layout.addLayout(prompt_header)

        self.prompt_widget = QWidget(); self.prompt_widget.setMaximumHeight(70)
        prompt_widget_layout = QVBoxLayout(self.prompt_widget); prompt_widget_layout.setContentsMargins(0,0,0,0)
        self.template_list_widget = QListWidget(); self.template_list_widget.setMaximumHeight(65)
        self.template_list_widget.itemClicked.connect(self.on_template_clicked)
        self.template_list_widget.setStyleSheet("QListWidget { background-color: white; } QListWidget::item { padding: 3px; } QListWidget::item:selected { background-color: #2196F3; color: white; }")
        prompt_widget_layout.addWidget(self.template_list_widget)
        ctrl_layout.addWidget(self.prompt_widget)
        self.refresh_template_list()

        mode_tab = QWidget()
        mode_layout = QHBoxLayout(mode_tab); mode_layout.setContentsMargins(0,0,0,0); mode_layout.setSpacing(10)
        self.img_mode_btn = QPushButton("👔 换装/裂变/创意模式"); self.img_mode_btn.setCheckable(True); self.img_mode_btn.setChecked(True)
        self.img_mode_btn.setStyleSheet("QPushButton:checked { background-color: #FF9800; color: white; }")
        self.img_mode_btn.clicked.connect(lambda: self.switch_mode(0))
        self.pass_mode_btn = QPushButton("🎨 口令生图模式"); self.pass_mode_btn.setCheckable(True)
        self.pass_mode_btn.setStyleSheet("QPushButton:checked { background-color: #2196F3; color: white; }")
        self.pass_mode_btn.clicked.connect(lambda: self.switch_mode(1))
        self.batch_mode_btn = QPushButton("👕 批量换装模式"); self.batch_mode_btn.setCheckable(True)
        self.batch_mode_btn.setStyleSheet("QPushButton:checked { background-color: #E91E63; color: white; }")
        self.batch_mode_btn.clicked.connect(lambda: self.switch_mode(2))
        mode_layout.addWidget(self.img_mode_btn); mode_layout.addWidget(self.pass_mode_btn); mode_layout.addWidget(self.batch_mode_btn); mode_layout.addStretch()
        ctrl_layout.addWidget(mode_tab)

        self.stacked_widget = QStackedWidget()
        multi_widget = QWidget(); multi_layout = QVBoxLayout(multi_widget); multi_layout.setSpacing(3)
        img_grid = QHBoxLayout()
        self.image_labels = []
        slot_names = ["图1: 模特/场景图", "图2: 服装/参考图", "图3: 搭配/细节图", "图4: 场景/参考图"]
        slot_descs = ["提供模特和场景", "提供服装/参考", "提供搭配/细节", "提供场景/参考"]
        for i in range(4):
            label = DragDropImageLabel(i, slot_names[i], slot_descs[i], self)
            label.imageDropped.connect(self.on_image_dropped); label.rightClicked.connect(self.clear_single_image)
            self.image_labels.append(label); img_grid.addWidget(label)
        img_grid.addStretch(); multi_layout.addLayout(img_grid)

        clear_row = QHBoxLayout()
        clear_imgs = QPushButton("🗑️ 一键清空"); clear_imgs.setFixedWidth(100); clear_imgs.clicked.connect(self.clear_all_images)
        clear_row.addWidget(clear_imgs); clear_row.addStretch(); multi_layout.addLayout(clear_row)

        sub_mode_layout = QHBoxLayout()
        self.change_clothes_btn = QPushButton("换装"); self.change_clothes_btn.setCheckable(True); self.change_clothes_btn.setChecked(True)
        self.change_clothes_btn.setStyleSheet("QPushButton:checked { background-color: #4CAF50; color: white; }")
        self.change_clothes_btn.clicked.connect(lambda: self.set_sub_mode("换装"))
        self.change_inner_btn = QPushButton("换内搭"); self.change_inner_btn.setCheckable(True); self.change_inner_btn.setStyleSheet("QPushButton:checked { background-color: #4CAF50; color: white; }")
        self.change_inner_btn.clicked.connect(lambda: self.set_sub_mode("换内搭"))
        self.change_face_btn = QPushButton("换头"); self.change_face_btn.setCheckable(True); self.change_face_btn.setStyleSheet("QPushButton:checked { background-color: #4CAF50; color: white; }")
        self.change_face_btn.clicked.connect(lambda: self.set_sub_mode("换头"))
        self.fission_btn_input = QPushButton("裂变"); self.fission_btn_input.setCheckable(True); self.fission_btn_input.setStyleSheet("QPushButton:checked { background-color: #4CAF50; color: white; }")
        self.fission_btn_input.clicked.connect(lambda: self.set_sub_mode("裂变"))
        self.creative_btn = QPushButton("创意无限"); self.creative_btn.setCheckable(True); self.creative_btn.setStyleSheet("QPushButton:checked { background-color: #4CAF50; color: white; }")
        self.creative_btn.clicked.connect(lambda: self.set_sub_mode("创意无限"))
        self.multi_change_btn = QPushButton("👥 多人换装/换内搭/换头"); self.multi_change_btn.setStyleSheet("background-color: #E91E63; color: white; font-weight: bold;")
        self.multi_change_btn.clicked.connect(lambda: self.open_multi_person_change(self.current_sub_mode if hasattr(self,'current_sub_mode') else "换装"))
        self.multi_fission_btn = QPushButton("👥 多人裂变"); self.multi_fission_btn.setStyleSheet("background-color: #FF5722; color: white; font-weight: bold;")
        self.multi_fission_btn.clicked.connect(self.open_multi_person_fission)
        sub_mode_layout.addWidget(self.change_clothes_btn); sub_mode_layout.addWidget(self.change_inner_btn); sub_mode_layout.addWidget(self.change_face_btn)
        sub_mode_layout.addWidget(self.fission_btn_input); sub_mode_layout.addWidget(self.creative_btn)
        sub_mode_layout.addWidget(self.multi_change_btn); sub_mode_layout.addWidget(self.multi_fission_btn); sub_mode_layout.addStretch()
        multi_layout.addLayout(sub_mode_layout)

        fission_from_inputs = QPushButton("🔥 1:1裂变生成2张"); fission_from_inputs.setFixedWidth(150); fission_from_inputs.setStyleSheet("background-color: #FF9800; color: white; font-weight: bold;")
        fission_from_inputs.clicked.connect(self.fission_from_input_images)
        multi_layout.addWidget(fission_from_inputs)

        tip = QLabel("💡 换装/换内搭/换头: 图1=目标图, 图2=参考图, 图3=搭配细节图 | 裂变: 图1=源图 | 创意无限: 自由创意")
        tip.setStyleSheet("color: #FF5722; font-size: 9px;"); multi_layout.addWidget(tip)
        self.stacked_widget.addWidget(multi_widget)

        pass_widget = QWidget(); pass_layout = QVBoxLayout(pass_widget); pass_layout.setSpacing(3)
        self.passphrase_container = PassphraseContainer(); self.passphrase_container.imagesChanged.connect(self.on_passphrase_images_changed)
        pass_layout.addWidget(self.passphrase_container)
        tip2 = QLabel("💡 上传图片 + 裂变提示词 + 选择数量 → 每个图片生成独立姿势")
        tip2.setStyleSheet("color: #666; font-size: 9px;"); pass_layout.addWidget(tip2)
        self.stacked_widget.addWidget(pass_widget)

        batch_widget = QWidget(); batch_main_layout = QVBoxLayout(batch_widget); batch_main_layout.setSpacing(10); batch_main_layout.setContentsMargins(5,5,5,5)
        top_layout = QHBoxLayout(); top_layout.setSpacing(40)
        self.clothes_container = ClothesContainer(); self.model_container = ModelContainer()
        top_layout.addWidget(self.clothes_container); top_layout.addWidget(self.model_container); top_layout.addStretch()
        batch_main_layout.addLayout(top_layout)

        bottom_layout = QVBoxLayout(); bottom_layout.setSpacing(5); bottom_layout.setContentsMargins(0,0,0,0)
        clear_all_batch_btn = QPushButton("🗑️ 清空所有图片"); clear_all_batch_btn.setFixedWidth(120); clear_all_batch_btn.clicked.connect(self.clear_batch_images)
        bottom_layout.addWidget(clear_all_batch_btn, 0, Qt.AlignLeft)
        tip3 = QLabel("💡 服装图最多3张，模特姿态图最多20张。点击「生成」将为每对服装和模特创建一个换装任务。")
        tip3.setStyleSheet("color: #E91E63; font-size: 9px;"); bottom_layout.addWidget(tip3, 0, Qt.AlignLeft)
        batch_main_layout.addLayout(bottom_layout)
        self.stacked_widget.addWidget(batch_widget)

        ctrl_layout.addWidget(self.stacked_widget)

        ctrl_layout.addSpacing(5)
        keyword_label = QLabel("📝 提示词/场景描述 (Ctrl+滚轮调整高度)"); keyword_label.setStyleSheet("font-weight: bold; font-size: 11px;")
        ctrl_layout.addWidget(keyword_label)
        self.keyword_input = ResizableTextEdit(); self.keyword_input.setPlaceholderText("输入场景描述..."); self.keyword_input.setFixedHeight(70)
        ctrl_layout.addWidget(self.keyword_input)

        ctrl_layout.addSpacing(4)
        save_path_label = QLabel("📁 保存路径"); save_path_label.setStyleSheet("font-weight: bold; font-size: 11px;")
        ctrl_layout.addWidget(save_path_label)
        save_row = QHBoxLayout()
        self.auto_save_path_edit = QLineEdit(); self.auto_save_path_edit.setPlaceholderText("自动使用图片源目录")
        self.auto_save_path_edit.setText(str(DEFAULT_IMAGE_DIR))
        save_row.addWidget(self.auto_save_path_edit, 1)
        self.auto_save_btn = QPushButton("浏览"); self.auto_save_btn.setFixedWidth(60); self.auto_save_btn.clicked.connect(self.select_save_path)
        save_row.addWidget(self.auto_save_btn)
        ctrl_layout.addLayout(save_row)

        ctrl_layout.addSpacing(3)
        param_layout = QHBoxLayout(); param_layout.setSpacing(10)
        params = QHBoxLayout()
        params.addWidget(QLabel("分辨率:"))
        self.resolution_combo = QComboBox(); self.resolution_combo.addItems(["1K","2K"]); self.resolution_combo.setFixedWidth(60)
        self.resolution_combo.currentTextChanged.connect(self.update_size_combo)
        params.addWidget(self.resolution_combo)
        params.addWidget(QLabel("尺寸:"))
        self.size_combo = QComboBox(); self.size_combo.setFixedWidth(60)
        params.addWidget(self.size_combo)
        params.addWidget(QLabel("人数:"))
        self.person_spin = QSpinBox(); self.person_spin.setRange(1,8); self.person_spin.setValue(1); self.person_spin.setFixedWidth(50)
        params.addWidget(self.person_spin)
        params.addWidget(QLabel("数量:"))
        self.num_spin = QSpinBox(); self.num_spin.setRange(1,4); self.num_spin.setValue(1); self.num_spin.setFixedWidth(50)
        params.addWidget(self.num_spin)
        param_layout.addLayout(params)
        param_layout.addStretch()
        self.fission_btn = QPushButton("⚡ 裂变选中"); self.fission_btn.setStyleSheet("background-color: #FF9800; color: white; font-weight: bold;")
        self.fission_btn.clicked.connect(self.fission_selected_preview)
        self.generate_btn = QPushButton("🚀 生成"); self.generate_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold; font-size: 13px; padding: 6px 25px;")
        self.generate_btn.clicked.connect(self.generate_action)
        param_layout.addWidget(self.fission_btn); param_layout.addWidget(self.generate_btn)
        ctrl_layout.addLayout(param_layout)

        self.update_size_combo()

        vertical_splitter.addWidget(preview_widget); vertical_splitter.addWidget(control_panel)
        vertical_splitter.setStretchFactor(0,4); vertical_splitter.setStretchFactor(1,2)

        right_layout.addWidget(vertical_splitter)
        main_splitter.addWidget(right)
        main_splitter.setStretchFactor(0,1); main_splitter.setStretchFactor(1,3)
        self.current_sub_mode = "换装"

    # ---------- 核心方法 ----------
    def clear_batch_images(self): self.clothes_container.clear_all(); self.model_container.clear_all()
    def on_task_selection_changed(self):
        selected = self.task_list_widget.selectedItems()
        self.selected_task_ids = {item.data(Qt.UserRole) for item in selected if item.data(Qt.UserRole)}
        all_paths = []
        for tid in self.selected_task_ids:
            task = self.task_manager.all_tasks.get(tid)
            if task: all_paths.extend(task.output_paths)
        if all_paths:
            self.clear_all_previews()
            for p in all_paths:
                if os.path.exists(p): self.add_image_to_preview(p)
    def on_task_list_right_click(self, pos):
        item = self.task_list_widget.itemAt(pos)
        if item:
            tid = item.data(Qt.UserRole)
            if tid:
                task = self.task_manager.all_tasks.get(tid)
                menu = QMenu()
                menu.setStyleSheet("QMenu { background-color: white; color: #333; } QMenu::item { padding: 5px 20px; } QMenu::item:selected { background-color: #2196F3; color: white; }")
                delete = QAction("删除任务", self); delete.triggered.connect(lambda: self.delete_single_task(tid)); menu.addAction(delete)
                if task and task.status == "failed":
                    retry = QAction("🔄 重新生成", self); retry.triggered.connect(lambda: self.retry_single_task(tid)); menu.addAction(retry)
                failed = self.task_manager.get_failed_tasks()
                if len(failed) > 1:
                    retry_all = QAction(f"🔄 重新生成所有失败任务 ({len(failed)}个)", self); retry_all.triggered.connect(self.retry_all_failed_tasks); menu.addAction(retry_all)
                menu.exec_(self.task_list_widget.mapToGlobal(pos))
    def retry_single_task(self, tid):
        if self.task_manager.retry_task(tid): QMessageBox.information(self, "提示", f"任务 #{tid} 已加入重新生成队列"); self.refresh_task_list()
        else: QMessageBox.warning(self, "错误", f"无法重试任务 #{tid}")
    def retry_all_failed_tasks(self):
        fails = self.task_manager.get_failed_tasks()
        if not fails: return
        if QMessageBox.question(self, "确认", f"重新生成 {len(fails)} 个失败任务？") == QMessageBox.Yes:
            cnt = self.task_manager.retry_multiple_tasks(fails)
            QMessageBox.information(self, "完成", f"已重新生成 {cnt} 个任务"); self.refresh_task_list()
    def delete_single_task(self, tid): self.task_manager.delete_task(tid); self.refresh_task_list()
    def on_preview_key_pressed(self, key):
        widgets = self.preview_container.image_widgets
        if not widgets: return
        cur = -1
        for i,w in enumerate(widgets):
            if w.selected: cur = i; break
        if key == Qt.Key_Left:
            if cur > 0:
                self.preview_container.clear_all_selections()
                widgets[cur-1].set_selected(True); self.preview_scroll.ensureWidgetVisible(widgets[cur-1])
            elif cur == -1 and widgets:
                self.preview_container.clear_all_selections()
                widgets[-1].set_selected(True); self.preview_scroll.ensureWidgetVisible(widgets[-1])
        elif key == Qt.Key_Right:
            if cur >= 0 and cur < len(widgets)-1:
                self.preview_container.clear_all_selections()
                widgets[cur+1].set_selected(True); self.preview_scroll.ensureWidgetVisible(widgets[cur+1])
            elif cur == -1 and widgets:
                self.preview_container.clear_all_selections()
                widgets[0].set_selected(True); self.preview_scroll.ensureWidgetVisible(widgets[0])
    def set_sub_mode(self, mode):
        self.current_sub_mode = mode
        self.change_clothes_btn.setChecked(mode=="换装")
        self.change_inner_btn.setChecked(mode=="换内搭")
        self.change_face_btn.setChecked(mode=="换头")
        self.fission_btn_input.setChecked(mode=="裂变")
        self.creative_btn.setChecked(mode=="创意无限")
        pc = self.person_spin.value()
        if mode == "换装":
            if pc > 1: self.keyword_input.setText(MULTI_PERSON_CHANGE_CLOTHES_TEMPLATE.format(person_count=pc))
            else: self.keyword_input.setText(CHANGE_CLOTHES_PROMPT_TEMPLATE)
        elif mode == "换内搭":
            if pc > 1: self.keyword_input.setText(MULTI_PERSON_CHANGE_INNER_TEMPLATE.format(person_count=pc))
            else: self.keyword_input.setText(CHANGE_INNER_PROMPT_TEMPLATE)
        elif mode == "换头":
            if pc > 1: self.keyword_input.setText(MULTI_PERSON_CHANGE_FACE_TEMPLATE.format(person_count=pc))
            else: self.keyword_input.setText(CHANGE_FACE_PROMPT_TEMPLATE)
        elif mode == "裂变":
            if pc > 1: self.keyword_input.setText(MULTI_PERSON_FISSION_TEMPLATE.format(person_count=pc))
            else: self.keyword_input.setText(FISSION_PROMPT_1V1)
        elif mode == "创意无限": self.keyword_input.setText("创意生成高质量图片，细节丰富，光影自然")
    def on_preview_selection_changed(self): pass

    def fission_selected_preview(self):
        selected = self.preview_container.get_selected_widgets() if self.preview_container else []
        if not selected: QMessageBox.information(self, "提示", "请先在预览区选中图片"); return
        dlg = QDialog(self); dlg.setWindowTitle("选择裂变类型"); dlg.setFixedWidth(400)
        layout = QVBoxLayout(dlg)
        layout.addWidget(QLabel("请选择裂变类型:"))
        btn1 = QPushButton("1:1裂变 (生成2张)"); btn1.setStyleSheet("background-color: #FF9800; color: white; font-weight: bold; padding: 8px;")
        btn2 = QPushButton("2:1裂变 (生成2张)"); btn2.setStyleSheet("background-color: #4CAF50; color: white; padding: 8px;")
        btn3 = QPushButton("3:2裂变 (生成2张)"); btn3.setStyleSheet("background-color: #4CAF50; color: white; padding: 8px;")
        layout.addWidget(btn1); layout.addWidget(btn2); layout.addWidget(btn3)
        def do(size, num):
            for w in selected:
                if size == "1:1": self.fission_1v1(w.img_path)
                else: self.fission_with_image_size(w.img_path, size, num)
                QCoreApplication.processEvents(); time.sleep(0.05)
            dlg.accept()
        btn1.clicked.connect(lambda: do("1:1",2)); btn2.clicked.connect(lambda: do("2:1",2)); btn3.clicked.connect(lambda: do("3:2",2))
        dlg.exec_()

    def fission_from_input_images(self):
        images = self.passphrase_container.images if self.passphrase_mode else [p for p in self.image_paths if p]
        if not images: QMessageBox.warning(self, "警告", "没有可用的输入图片"); return
        for img in images: self.fission_1v1(img); QCoreApplication.processEvents(); time.sleep(0.05)
    def on_passphrase_images_changed(self, images): pass
    def gen_single_passphrase(self, img_path):
        if self._generating: return
        prompt = self.keyword_input.toPlainText().strip()
        if not prompt: prompt = DEFAULT_PASSPHRASE_PROMPT
        save_dir = self.get_save_dir(img_path)
        num = self.num_spin.value(); person = self.person_spin.value()
        is_fission = "不同姿势" in prompt or "姿势动作变化大" in prompt or "1个模特" in prompt or "多人" in prompt or f"{person}个人物" in prompt
        if is_fission and num > 1:
            self.task_manager.add_fission_tasks(img_path, prompt, self.resolution_combo.currentText(), self.size_combo.currentText(), num, person, save_dir)
        else:
            self.task_manager.add_task([img_path], prompt, "口令", self.resolution_combo.currentText(), self.size_combo.currentText(), num, person, save_dir)
    def clear_single_image(self, idx): self.image_paths[idx] = ""; self.image_labels[idx].clear_image()
    def clear_all_images(self):
        for i in range(4): self.clear_single_image(i)
    def on_image_dropped(self, idx, path): self.image_paths[idx] = path; self.image_labels[idx].set_image(path)
    def select_save_path(self):
        path = QFileDialog.getExistingDirectory(self, "选择默认保存目录", str(DEFAULT_IMAGE_DIR))
        if path: APP_CONFIG["auto_save_path"] = path; self.auto_save_path_edit.setText(path)

    def generate_action(self):
        if self._generate_lock or self._generating: return
        self._generate_lock = True
        self.generate_btn.setEnabled(False); self.generate_btn.setText("生成中...")
        QApplication.processEvents()
        QTimer.singleShot(50, self._do_generate)

    def _do_generate(self):
        try:
            if self.batch_mode:
                clothes = self.clothes_container.images; models = self.model_container.images
                if not clothes or not models: QMessageBox.warning(self, "警告", "请至少添加一张服装图和一张模特姿态图"); return
                prompt = self.keyword_input.toPlainText().strip()
                if not prompt: prompt = BATCH_CHANGE_CLOTHES_PROMPT
                res = self.resolution_combo.currentText(); size = self.size_combo.currentText()
                save_dir = self.get_save_dir(models[0]) if models else str(DEFAULT_IMAGE_DIR)
                task_ids = self.task_manager.add_batch_clothes_tasks(clothes, models, prompt, res, size, save_dir)
                print(f"[批量换装] 服装{len(clothes)}张，模特{len(models)}张，共创建{len(task_ids)}个任务")
            elif self.passphrase_mode:
                images = self.passphrase_container.images if self.passphrase_container else []
                if not images: QMessageBox.warning(self, "警告", "请先添加图片"); return
                prompt = self.keyword_input.toPlainText().strip()
                res = self.resolution_combo.currentText(); size = self.size_combo.currentText()
                num = self.num_spin.value(); person = self.person_spin.value()
                is_fission = "不同姿势" in prompt or "姿势动作变化大" in prompt or "1个模特" in prompt or "多人" in prompt
                for img in images:
                    save_dir = self.get_save_dir(img)
                    if is_fission and num > 1:
                        self.task_manager.add_fission_tasks(img, prompt, res, size, num, person, save_dir)
                    else:
                        self.task_manager.add_task([img], prompt, "口令", res, size, num, person, save_dir)
                        QCoreApplication.processEvents(); time.sleep(0.003)
            else:
                images = [p for p in self.image_paths if p]
                if not images: QMessageBox.warning(self, "警告", "请上传图片"); return
                prompt = self.keyword_input.toPlainText().strip()
                res = self.resolution_combo.currentText(); size = self.size_combo.currentText()
                num = self.num_spin.value(); person = self.person_spin.value()
                if self.current_sub_mode == "裂变":
                    src = images[0]; save_dir = self.get_save_dir(src)
                    ref_prompt = prompt
                    if len(images) > 1 and images[1]: ref_prompt = f"{prompt} 参考图二的衣服细节、扣子、纹理等特征来保持一致性。"
                    if size == "1:1": self.task_manager.add_fission_tasks(src, ref_prompt, res, size, 2, person, save_dir)
                    else: self.task_manager.add_fission_tasks(src, ref_prompt, res, size, 2, person, save_dir)
                elif self.current_sub_mode == "创意无限":
                    for img in images:
                        save_dir = self.get_save_dir(img)
                        self.task_manager.add_creative_task(img, prompt, res, size, save_dir)
                elif self.current_sub_mode in ["换装","换内搭","换头"]:
                    if len(images) < 2: QMessageBox.warning(self, "警告", f"{self.current_sub_mode}需要上传目标图和参考图"); return
                    target = images[0]; refs = [target]
                    if len(images) > 1 and images[1]: refs.append(images[1])
                    if len(images) > 2 and images[2]:
                        refs.append(images[2])
                        if person > 1: prompt = f"{prompt} 参考图三的穿搭细节、内搭款式、颜色。"
                    if len(images) > 3 and images[3]:
                        refs.append(images[3])
                        if person > 1: prompt = f"{prompt} 参考图四的场景氛围、光影效果。"
                    self.task_manager.add_task(refs, prompt, self.current_sub_mode, res, size, num, person, self.get_save_dir(target))
        except Exception as e:
            QMessageBox.warning(self, "错误", f"添加任务失败: {str(e)}")
        finally:
            self._generating = False; self._generate_lock = False
            self.generate_btn.setEnabled(True); self.generate_btn.setText("生成")
            self.refresh_task_list()

    def switch_mode(self, mode_index):
        if mode_index == 0:
            self.batch_mode = False; self.passphrase_mode = False
            self.img_mode_btn.setChecked(True); self.pass_mode_btn.setChecked(False); self.batch_mode_btn.setChecked(False)
            self.stacked_widget.setCurrentIndex(0); self.num_spin.setMaximum(4)
        elif mode_index == 1:
            self.batch_mode = False; self.passphrase_mode = True
            self.img_mode_btn.setChecked(False); self.pass_mode_btn.setChecked(True); self.batch_mode_btn.setChecked(False)
            self.stacked_widget.setCurrentIndex(1); self.num_spin.setMaximum(4)
        else:
            self.batch_mode = True; self.passphrase_mode = False
            self.img_mode_btn.setChecked(False); self.pass_mode_btn.setChecked(False); self.batch_mode_btn.setChecked(True)
            self.stacked_widget.setCurrentIndex(2); self.num_spin.setMaximum(4)
            if not self.keyword_input.toPlainText().strip(): self.keyword_input.setText(BATCH_CHANGE_CLOTHES_PROMPT)
        self.update_api_status_label()

    def reset_splitter(self):
        sp = self.centralWidget()
        if isinstance(sp, QSplitter): sp.setSizes([300, sp.width()-300])

    def refresh_template_list(self):
        self.template_list_widget.clear()
        special = [CHANGE_CLOTHES_PROMPT_TEMPLATE, CHANGE_INNER_PROMPT_TEMPLATE, CHANGE_FACE_PROMPT_TEMPLATE, FISSION_PROMPT_1V1, "创意无限 - 一键去水印", "创意无限 - 一键换装", BATCH_CHANGE_CLOTHES_PROMPT]
        all_tpl = special + [t for t in self.prompt_templates if t not in special]
        for i,tpl in enumerate(all_tpl,1):
            display = tpl[:40]+"..." if len(tpl)>40 else tpl
            item = QListWidgetItem(f"{i}. {display}")
            item.setData(Qt.UserRole, tpl); item.setToolTip(tpl)
            self.template_list_widget.addItem(item)

    def on_template_clicked(self, item): self.keyword_input.setText(item.data(Qt.UserRole))
    def toggle_prompt_area(self, checked):
        self.prompt_widget.setVisible(checked)
        self.prompt_toggle_btn.setText("▼ 提示词库" if checked else "▶ 提示词库")
    def manage_templates(self):
        dlg = PromptTemplateDialog(self.prompt_templates, self)
        if dlg.exec_() == QDialog.Accepted:
            self.prompt_templates = dlg.templates
            self.save_prompt_templates(self.prompt_templates); self.refresh_template_list()

    def on_task_finished(self, local_id, outputs, error_msg, elapsed):
        self.refresh_task_list()
        if not error_msg and outputs:
            self.statusBar().showMessage(f"✅ 任务#{local_id}完成！生成{len(outputs)}张图片，耗时{elapsed:.1f}s", 3000)

    def on_image_ready(self, img_path):
        try:
            if not os.path.exists(img_path): return
            for w in self.preview_container.image_widgets:
                if w.img_path == img_path: return
            self.pending_images.add(img_path); self.pending_timer.start(200)
        except Exception as e: print(f"[on_image_ready] error: {e}")
    def flush_pending_images(self):
        if not self.pending_images: return
        try:
            for path in list(self.pending_images):
                exists = False
                for w in self.preview_container.image_widgets:
                    if w.img_path == path: exists = True; break
                if not exists: self.add_image_to_preview(path)
            self.pending_images.clear()
        except Exception as e: print(f"[flush] error: {e}"); self.pending_images.clear()

    def clear_all_tasks(self):
        self.task_manager.clear_all_tasks(); self.refresh_task_list(); self.clear_all_previews()

    def _apply_pending_updates(self):
        for local_id in self._pending_updates:
            task = self.task_manager.all_tasks.get(local_id)
            if task and task._progress_bar is not None:
                task._progress_bar.setValue(task.progress)
        self._pending_updates.clear()

    def refresh_task_list(self):
        selected_ids = set()
        for item in self.task_list_widget.selectedItems():
            tid = item.data(Qt.UserRole)
            if tid is not None: selected_ids.add(tid)
        self.task_list_widget.clear()
        for local_id in reversed(self.task_manager.task_order):
            task = self.task_manager.all_tasks.get(local_id)
            if task:
                container = QWidget()
                hbox = QHBoxLayout(container)
                hbox.setContentsMargins(5,2,5,2); hbox.setSpacing(8)
                icon = QLabel()
                status_icons = {"pending":"⏳","uploading":"📤","submitted":"📨","running":"🎨","success":"✅","failed":"❌"}
                icon.setText(status_icons.get(task.status,"❓")); icon.setFixedWidth(25)
                hbox.addWidget(icon)
                info = QLabel()
                status_text = {"pending":"等待","uploading":"上传中","submitted":"提交中","running":f"{task.progress}%","success":"完成","failed":"失败"}
                disp = status_text.get(task.status, task.status)
                time_txt = f"{task.elapsed_seconds:.1f}s" if task.elapsed_seconds>0 else ""
                person_info = f"👥{task.person_count}人" if task.person_count>1 else ""
                info.setText(f"#{local_id} | {task.mode}{person_info} | {task.size} | {disp} | {time_txt}")
                info.setStyleSheet("font-size:11px; color:#333;")
                hbox.addWidget(info,1)
                pb = QProgressBar()
                pb.setFixedWidth(100); pb.setFixedHeight(6); pb.setRange(0,100); pb.setValue(task.progress); pb.setTextVisible(False)
                pb.setStyleSheet("QProgressBar { border: none; background-color: #e0e0e0; border-radius: 3px; } QProgressBar::chunk { background-color: #2196F3; border-radius: 3px; }")
                hbox.addWidget(pb)
                task._list_item = None; task._progress_bar = pb
                item = QListWidgetItem()
                item.setData(Qt.UserRole, local_id); item.setSizeHint(QSize(0,38))
                self.task_list_widget.addItem(item)
                self.task_list_widget.setItemWidget(item, container)
                task._list_item = item
        for i in range(self.task_list_widget.count()):
            item = self.task_list_widget.item(i)
            tid = item.data(Qt.UserRole)
            if tid is not None and tid in selected_ids: item.setSelected(True)

    def on_task_updated(self, local_id):
        if local_id == -1: self.refresh_task_list(); return
        task = self.task_manager.all_tasks.get(local_id)
        if not task: return
        self._pending_updates.add(local_id)
        if not self._update_timer.isActive(): self._update_timer.start(200)

    def add_image_to_preview(self, img_path):
        try:
            for w in self.preview_container.image_widgets:
                if w.img_path == img_path: return
            widget = DraggablePreviewImage(img_path)
            widget.right_clicked.connect(self.on_preview_right_clicked)
            widget.fission_requested.connect(self.fission_with_image_size)
            self.preview_container.add_image(widget)
        except Exception as e: print(f"[add_image_to_preview] error: {e}")

    def on_preview_right_clicked(self, widget, pos):
        menu = QMenu()
        menu.setStyleSheet("QMenu { background-color: white; } QMenu::item { padding: 5px 20px; } QMenu::item:selected { background-color: #2196F3; color: white; }")
        save = QAction("保存到指定位置", self); save.triggered.connect(lambda: self.save_single_image(widget.img_path))
        fission1 = QAction("1:1裂变(2张)", self); fission1.triggered.connect(lambda: self.fission_1v1(widget.img_path))
        fission2 = QAction("2:1裂变(2张)", self); fission2.triggered.connect(lambda: self.fission_with_image_size(widget.img_path,"2:1",2))
        fission3 = QAction("3:2裂变(2张)", self); fission3.triggered.connect(lambda: self.fission_with_image_size(widget.img_path,"3:2",2))
        creative = QAction("创意无限", self); creative.triggered.connect(lambda: self.gen_creative_mode(widget.img_path))
        delete = QAction("删除", self); delete.triggered.connect(lambda: self.preview_container.remove_image(widget))
        menu.addAction(save); menu.addSeparator(); menu.addAction(fission1); menu.addAction(fission2); menu.addAction(fission3); menu.addAction(creative); menu.addSeparator(); menu.addAction(delete)
        menu.exec_(pos)

    def save_single_image(self, img_path):
        if not os.path.exists(img_path): QMessageBox.warning(self,"错误","图片文件不存在"); return
        name = os.path.basename(img_path)
        dest, _ = QFileDialog.getSaveFileName(self,"保存图片",name,"PNG图片 (*.png);;JPEG图片 (*.jpg *.jpeg)")
        if dest:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(img_path, dest)
            QMessageBox.information(self,"完成",f"已保存到:\n{dest}")

    def select_all_previews(self):
        for w in self.preview_container.image_widgets:
            if not w.selected: w.set_selected(True)
    def save_selected_images(self):
        selected = self.preview_container.get_selected_widgets()
        if not selected: QMessageBox.information(self,"提示","请先选中图片"); return
        target_dir = QFileDialog.getExistingDirectory(self,"选择保存目录")
        if target_dir:
            os.makedirs(target_dir, exist_ok=True)
            cnt = 0
            for w in selected:
                shutil.copy2(w.img_path, os.path.join(target_dir, os.path.basename(w.img_path))); cnt += 1
            QMessageBox.information(self,"完成",f"已保存 {cnt} 张图片")
    def delete_selected_previews(self):
        for w in self.preview_container.get_selected_widgets():
            self.preview_container.remove_image(w); w.deleteLater()
    def clear_all_previews(self): self.preview_container.clear_all()

if __name__ == "__main__":
    QCoreApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QCoreApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
    app = QApplication(sys.argv)
    if not bridge_ready():
        QMessageBox.critical(None, "无法启动", "本插件必须在灵坊桌面客户端中运行（缺少平台桥环境变量）。")
        sys.exit(1)
    app.setStyle("Fusion")
    font = QFont("Microsoft YaHei", 9)
    app.setFont(font)
    icon_path = resource_path("favicon.ico") if os.path.exists(resource_path("favicon.ico")) else resource_path("favicon (4).ico")
    if os.path.exists(icon_path): app.setWindowIcon(QIcon(icon_path))
    DEFAULT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    for f in Path(".").glob("temp_*.png"): f.unlink()
    for f in Path(".").glob("drag_*.png"): f.unlink()
    print(f"[启动] 档位: {LocalAPIGenerator.get_tier()} | 并发: {get_max_concurrent()} | 超时: {get_timeout()}s | 重试: {get_retry_count()}次")
    window = MainWindow()
    window.show()
    sys.exit(app.exec_())
