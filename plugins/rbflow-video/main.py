# -*- coding: utf-8 -*-
"""
RBFLow 动作迁移视频生成插件（PySide6 / Qt6）。

功能：
  - 上传参考图片 + 参考视频 → 笛卡尔积生成任务
  - 经平台桥 /video/generate 按视频时长（秒）扣灵石（PER_SECOND）
  - 桥代理转发到平台运营的 RBFLow 实例生成视频（用户无凭证，防绕过）
  - SSE 实时进度（经桥 /video/stream 代理）
  - 完成后下载成品 mp4 落盘到自定义文件夹（支持日期/分类子目录）
  - 任务队列排序、状态筛选、批量操作、自动重试

安全边界：
  - 插件进程 env 只有 LINGFANG_PLUGIN_BRIDGE_URL / TOKEN（桌面注入）。
  - 插件不持有、不感知任何 RBFLow / RunningHub 凭证。所有 RBFLow 调用经平台桥代理。
  - 用户物理上无法绕过灵石计费直连 RBFLow。
"""

import sys
import os
import json
import time
import base64
import logging
import traceback
import mimetypes
import subprocess
import shutil
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QLabel,
    QPushButton, QLineEdit, QComboBox, QListWidget, QListWidgetItem, QFileDialog,
    QProgressBar, QTabWidget, QCheckBox, QMessageBox,
    QSizePolicy, QFrame, QMenu, QAbstractItemView, QSplitter, QStatusBar,
    QDialog, QDialogButtonBox,
    QSystemTrayIcon,
)
from PySide6.QtCore import (
    Qt, QThread, Signal, QSize, QTimer, QSettings, QMimeData, QPoint, QUrl,
)
from PySide6.QtGui import (
    QPixmap, QImage, QAction, QIcon, QColor, QFont, QPainter,
    QDragEnterEvent, QDropEvent, QDesktopServices,
)

import requests

try:
    from PIL import Image as PILImage
    HAS_PIL = True
except Exception:
    HAS_PIL = False

# ==================== 全局异常捕获 ====================
def global_exception_handler(exc_type, exc_value, exc_tb):
    logging.error(f"未捕获异常: {exc_type.__name__}: {exc_value}")
    logging.error("".join(traceback.format_exception(exc_type, exc_value, exc_tb)))

sys.excepthook = global_exception_handler

# ==================== 路径 / 日志 ====================
PLUGIN_DIR = Path(__file__).parent
DATA_DIR = PLUGIN_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    filename=str(DATA_DIR / "app.log"),
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)

# ==================== 桥配置（桌面壳注入，无 fallback 默认值——平台 AI 政策） ====================
_BRIDGE_URL = os.environ.get("LINGFANG_PLUGIN_BRIDGE_URL", "").rstrip("/")
_BRIDGE_TOKEN = os.environ.get("LINGFANG_PLUGIN_BRIDGE_TOKEN", "")


def bridge_ready() -> bool:
    """是否在桌面壳内运行（桥变量已注入）。"""
    return bool(_BRIDGE_URL and _BRIDGE_TOKEN)


def _bridge_headers() -> dict:
    return {"X-LingFang-Plugin-Token": _BRIDGE_TOKEN}


# ==================== 桥客户端（所有 RBFLow 调用经桥代理，插件无 RBFLow 凭证） ====================
# 桥路由（plugin_llm_bridge.rs 已实现）：
#   POST /video/generate   {image, video, seconds, model}  → {task_id, call_log_id, charged, credits}
#   注：桥 parse_model_tier 读 `model` 字段（fast/premium 哨兵），非 `tier`——与 SDK
#   invokeAi 注入 model 的行为一致。插件虽传 tier 变量，但 body key 必须是 `model`。
#   GET  /video/stream?task_id=X   → {task_id, events:[...]}  （SSE 聚合成数组，桥非流式）
#   GET  /video/download?task_id=X → {task_id, data(base64), filename, mime_type, size}

TIER_CHOICES = ["fast", "premium"]
DEFAULT_TIER = "fast"

# ---- 工作流节点配置（写死，不需要用户配置——桥 forwardToRbflow 只认固定字段名 image/video） ----
IMAGE_NODE_ID = "78"
IMAGE_FIELD_NAME = "image"
VIDEO_NODE_ID = "77"
VIDEO_FIELD_NAME = "video"


# ==================== 支持拖拽的 QListWidget 子类 ====================
# PySide6 的 Qt 事件分发走 C++ 虚函数表——直接赋值实例属性（self.list.dropEvent = ...）
# 不会被 Qt 调用。必须子类化并在类层级重写虚函数，Qt 才会正确分发。

class DropListWidget(QListWidget):
    """支持从文件管理器拖拽文件添加的 QListWidget。
    子类化重写 dragEnterEvent/dragMoveEvent/dropEvent（PySide6 要求类层级重写，
    实例属性赋值无效）。回调 on_drop(paths) 由面板实现。
    """
    files_dropped = Signal(list)  # list[str] of file paths

    def __init__(self, valid_exts: set, parent=None):
        super().__init__(parent)
        self._valid_exts = valid_exts
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DropOnly)

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event):
        paths = []
        for url in event.mimeData().urls():
            p = url.toLocalFile()
            if p and Path(p).suffix.lower() in self._valid_exts:
                paths.append(p)
        if paths:
            self.files_dropped.emit(paths)
        event.acceptProposedAction()

# ==================== 主题调色板 + QSS 模板 ====================
# QSS 不支持变量，这里用 Python dict + f-string 模板动态生成深色/亮色样式表。

DARK_COLORS = {
    "base": "#1e1e2e",       # 主背景
    "mantle": "#181825",     # 面板/顶栏
    "crust": "#11111b",      # 输入框/列表底
    "surface0": "#313244",   # 按钮底
    "surface1": "#45475a",   # hover
    "surface2": "#585b70",
    "overlay0": "#6c7086",   # 次要文字
    "overlay1": "#7f849c",
    "overlay2": "#9399b2",
    "subtext0": "#a6adc8",
    "text": "#cdd6f4",       # 主文字
    "blue": "#89b4fa",       # 强调色
    "blue_hover": "#b4befe",
    "blue_press": "#74c7ec",
    "lavender": "#b4befe",
    "green": "#a6e3a1",
    "red": "#f38ba8",
    "yellow": "#f9e2af",
}

LIGHT_COLORS = {
    "base": "#ffffff",
    "mantle": "#f5f5f5",
    "crust": "#ececec",
    "surface0": "#e2e2e2",
    "surface1": "#d4d4d4",
    "surface2": "#bfbfbf",
    "overlay0": "#6b6b6b",
    "overlay1": "#555555",
    "overlay2": "#404040",
    "subtext0": "#333333",
    "text": "#1e1e2e",
    "blue": "#3b82f6",
    "blue_hover": "#2563eb",
    "blue_press": "#1d4ed8",
    "lavender": "#7c83ff",
    "green": "#16a34a",
    "red": "#dc2626",
    "yellow": "#b45309",
}

THEME_DARK = "dark"
THEME_LIGHT = "light"

# 复选框勾选标记：内联 SVG 数据 URL（深蓝/蓝色对号），在深色与亮色主题下都用强调色绘制
def _check_svg(color: str) -> str:
    # url-encoded SVG for QSS image: url("data:image/svg+xml,...")
    svg = (
        f"<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'>"
        f"<path d='M3 8.5 L6.5 12 L13 4' stroke='{color}' stroke-width='2.4' "
        f"fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>"
    )
    # 把 SVG 做成 data url（用 url() 包裹前转义必要字符）
    import urllib.parse
    return "url(\"data:image/svg+xml," + urllib.parse.quote(svg) + "\")"


def build_qss(c: dict) -> str:
    """根据配色 dict 生成完整 QSS 字符串。"""
    return f"""\
/* === RBFLow 视频生成插件 · 动态主题（{'暗色' if c is DARK_COLORS else '亮色'}） === */

* {{
    font-family: "Microsoft YaHei UI", "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    font-size: 13px;
    color: {c["text"]};
    outline: none;
}}

QMainWindow, QWidget#CentralWidget {{
    background-color: {c["base"]};
}}

QFrame#TopBar {{
    background-color: {c["mantle"]};
    border-bottom: 1px solid {c["surface0"]};
}}

QLabel#AppTitle {{
    font-size: 16px;
    font-weight: 600;
    color: {c["text"]};
}}

QLabel#StatusBadge {{
    color: {c["green"]};
    font-size: 12px;
}}

QFrame#Panel {{
    background-color: {c["mantle"]};
    border: 1px solid {c["surface0"]};
    border-radius: 10px;
}}

QSplitter {{ background-color: transparent; }}
QSplitter::handle:horizontal {{
    background-color: {c["mantle"]};
    width: 3px;
    margin: 8px 1px;
    border-radius: 1px;
}}
QSplitter::handle:horizontal:hover {{
    background-color: {c["blue"]};
    width: 4px;
}}

QLabel#PanelTitle {{
    font-size: 14px;
    font-weight: 600;
    color: {c["blue"]};
    padding: 2px 0px;
}}
QLabel#SectionLabel {{
    color: {c["subtext0"]};
    font-size: 12px;
    font-weight: 500;
}}

/* ---- 按钮 ---- */
QPushButton {{
    background-color: {c["surface0"]};
    border: 1px solid {c["surface1"]};
    border-radius: 6px;
    padding: 6px 14px;
    color: {c["text"]};
}}
QPushButton:hover {{
    background-color: {c["surface1"]};
    border-color: {c["surface2"]};
}}
QPushButton:pressed {{
    background-color: {c["crust"]};
}}
QPushButton:disabled {{
    color: {c["surface2"]};
    background-color: {c["base"]};
    border-color: {c["surface0"]};
}}

QPushButton#PrimaryBtn {{
    background-color: {c["blue"]};
    border: none;
    color: {c["base"]};
    font-weight: 600;
}}
QPushButton#PrimaryBtn:hover {{ background-color: {c["blue_hover"]}; }}
QPushButton#PrimaryBtn:pressed {{ background-color: {c["blue_press"]}; }}
QPushButton#PrimaryBtn:disabled {{
    background-color: {c["surface1"]};
    color: {c["surface2"]};
}}

QPushButton#DangerBtn {{
    background-color: transparent;
    border: 1px solid {c["red"]};
    color: {c["red"]};
}}
QPushButton#DangerBtn:hover {{
    background-color: {c["red"]};
    color: {c["base"]};
}}

QPushButton#IconBtn {{
    background-color: transparent;
    border: none;
    padding: 4px 8px;
    color: {c["subtext0"]};
    font-size: 14px;
}}
QPushButton#IconBtn:hover {{
    color: {c["text"]};
    background-color: {c["surface0"]};
    border-radius: 4px;
}}

/* 卡片右侧操作按钮（带边框：重试绿/保存蓝/删除红） */
QPushButton#CardBtnRetry {{
    background-color: transparent;
    border: 1px solid {c["green"]};
    border-radius: 5px;
    color: {c["green"]};
    font-size: 14px;
    padding: 0px;
}}
QPushButton#CardBtnRetry:hover {{ background-color: {c["green"]}; color: {c["base"]}; }}
QPushButton#CardBtnRetry:disabled {{
    color: {c["surface2"]};
    border-color: {c["surface0"]};
    background-color: transparent;
}}
QPushButton#CardBtnSave {{
    background-color: transparent;
    border: 1px solid {c["blue"]};
    border-radius: 5px;
    color: {c["blue"]};
    font-size: 14px;
    padding: 0px;
}}
QPushButton#CardBtnSave:hover {{ background-color: {c["blue"]}; color: {c["base"]}; }}
QPushButton#CardBtnSave:disabled {{
    color: {c["surface2"]};
    border-color: {c["surface0"]};
    background-color: transparent;
}}
QPushButton#CardBtnDelete {{
    background-color: transparent;
    border: 1px solid {c["red"]};
    border-radius: 5px;
    color: {c["red"]};
    font-size: 13px;
    padding: 0px;
}}
QPushButton#CardBtnDelete:hover {{ background-color: {c["red"]}; color: {c["base"]}; }}

/* 顶栏主题切换按钮 */
QPushButton#ThemeToggle {{
    background-color: transparent;
    border: 1px solid {c["surface1"]};
    border-radius: 12px;
    color: {c["yellow"]};
    font-size: 15px;
    padding: 2px 8px;
}}
QPushButton#ThemeToggle:hover {{
    background-color: {c["surface0"]};
}}

/* ---- 输入控件 ---- */
QLineEdit, QComboBox, QSpinBox {{
    background-color: {c["crust"]};
    border: 1px solid {c["surface0"]};
    border-radius: 6px;
    padding: 5px 8px;
    color: {c["text"]};
    selection-background-color: {c["blue"]};
    selection-color: {c["base"]};
}}
QLineEdit:focus, QComboBox:focus {{ border-color: {c["blue"]}; }}
QComboBox::drop-down {{ border: none; width: 20px; }}
QComboBox QAbstractItemView {{
    background-color: {c["mantle"]};
    border: 1px solid {c["surface0"]};
    border-radius: 6px;
    selection-background-color: {c["surface0"]};
    outline: none;
}}

/* ---- 列表 ---- */
QListWidget {{
    background-color: {c["crust"]};
    border: 1px solid {c["surface0"]};
    border-radius: 8px;
    padding: 4px;
    outline: none;
}}
QListWidget::item {{
    border-radius: 6px;
    padding: 4px;
}}
QListWidget::item:selected {{
    background-color: {c["surface0"]};
}}
QListWidget::item:hover {{
    background-color: {c["base"]};
}}

QListWidget#ImageList, QListWidget#VideoList {{
    background-color: {c["crust"]};
    border: 1px solid {c["surface0"]};
    border-radius: 8px;
}}
QListWidget#ImageList::item, QListWidget#VideoList::item {{
    border-radius: 8px;
    margin: 3px;
    border: 2px solid transparent;
}}
QListWidget#ImageList::item:selected, QListWidget#VideoList::item:selected {{
    border: 2px solid {c["blue"]};
    background-color: {c["surface0"]};
}}

/* 任务列表 item：给选中态留 padding，避免选中背景覆盖卡片底部按钮 */
QListWidget#TaskList::item {{
    padding: 3px;
    margin: 1px 0px;
    border-radius: 8px;
}}
QListWidget#TaskList::item:selected {{
    background-color: {c["surface0"]};
}}

/* ---- 进度条 ---- */
QProgressBar {{
    background-color: {c["crust"]};
    border: 1px solid {c["surface0"]};
    border-radius: 4px;
    text-align: center;
    color: {c["text"]};
    height: 16px;
}}
QProgressBar::chunk {{
    background-color: {c["blue"]};
    border-radius: 3px;
}}

/* ---- Tab ---- */
QTabWidget::pane {{
    border: 1px solid {c["surface0"]};
    border-radius: 6px;
    top: -1px;
}}
QTabBar::tab {{
    background-color: transparent;
    color: {c["overlay0"]};
    padding: 5px 12px;
    border: 1px solid transparent;
    border-bottom: none;
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
}}
QTabBar::tab:selected {{
    color: {c["text"]};
    background-color: {c["mantle"]};
    border-color: {c["surface0"]};
}}
QTabBar::tab:hover:!selected {{ color: {c["subtext0"]}; }}

/* ---- 滚动条 ---- */
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0; }}
QScrollBar::handle:vertical {{
    background: {c["surface0"]};
    border-radius: 5px;
    min-height: 30px;
}}
QScrollBar::handle:vertical:hover {{ background: {c["surface1"]}; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 0; }}
QScrollBar::handle:horizontal {{
    background: {c["surface0"]};
    border-radius: 5px;
    min-width: 30px;
}}

/* ---- 任务卡片 ---- */
QFrame#TaskCard {{
    background-color: {c["mantle"]};
    border: 1px solid {c["surface0"]};
    border-radius: 8px;
}}
QFrame#TaskCard:hover {{ border-color: {c["surface1"]}; }}

QLabel#TaskFilename {{ color: {c["text"]}; font-weight: 500; }}
QLabel#TaskMeta {{ color: {c["overlay0"]}; font-size: 11px; }}

/* ---- 复选框（用 Qt 原生勾选标记，不在 QSS 里画 indicator——QSS image data URI 在 Windows Qt6 上不可靠） ---- */
QCheckBox {{ spacing: 6px; color: {c["text"]}; }}

/* ---- 分组框 ---- */
QGroupBox {{
    border: 1px solid {c["surface0"]};
    border-radius: 8px;
    margin-top: 10px;
    padding-top: 8px;
    color: {c["subtext0"]};
    font-weight: 500;
}}
QGroupBox::title {{
    subcontrol-origin: margin;
    left: 10px;
    padding: 0 4px;
}}

QDialog {{ background-color: {c["mantle"]}; }}

QLabel#HintLabel {{ color: {c["overlay0"]}; font-size: 11px; }}
QLabel#CreditLabel {{ color: {c["yellow"]}; font-weight: 600; }}
"""


class BridgeError(Exception):
    """桥调用失败。code 用于区分 insufficient_balance 等。"""
    def __init__(self, message: str, code: str = "", status: int = 0):
        super().__init__(message)
        self.code = code
        self.status = status


def _parse_bridge_error(resp: requests.Response) -> BridgeError:
    """桥错误 body: {code, message, requestId}。"""
    try:
        ej = resp.json()
        return BridgeError(
            str(ej.get("message", resp.text[:200])),
            code=str(ej.get("code", "")),
            status=resp.status_code,
        )
    except Exception:
        return BridgeError(f"桥错误 {resp.status_code}: {resp.text[:200]}", status=resp.status_code)


def bridge_submit_video(image_path: str, video_path: str, seconds: float, tier: str = DEFAULT_TIER,
                        timeout=(30, 120)) -> dict:
    """提交一个图片+视频任务。返回 {task_id, call_log_id, charged, credits}。

    桥先按秒扣灵石，再代理转发到 RBFLow。余额不足(402)抛 BridgeError(code=insufficient_balance)。
    """
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()
    with open(video_path, "rb") as f:
        vid_b64 = base64.b64encode(f.read()).decode()

    body = {
        "image": img_b64,
        "video": vid_b64,
        "image_filename": os.path.basename(image_path),
        "video_filename": os.path.basename(video_path),
        "seconds": seconds,
        "model": tier,
    }
    resp = requests.post(
        _BRIDGE_URL + "/video/generate",
        json=body, headers=_bridge_headers(), timeout=timeout,
    )
    if resp.status_code != 200:
        raise _parse_bridge_error(resp)
    return resp.json()


def bridge_stream_video(task_id: str, timeout=(10, 600)) -> list:
    """拉取任务 SSE 事件（桥聚合返回 events 数组）。每个 event 是 dict。

    事件类型（RBFLow v0.4）：
      progress: {type, progress, node, node_progress, state}
      done:     {type, progress, state, file_url, local_path, filename}
      error:    {type, state, reason, error_code, error_advice}
    """
    resp = requests.get(
        _BRIDGE_URL + "/video/stream",
        params={"task_id": task_id},
        headers=_bridge_headers(), timeout=timeout,
    )
    if resp.status_code != 200:
        raise _parse_bridge_error(resp)
    data = resp.json()
    return data.get("events", [])


def bridge_download_video(task_id: str, timeout=(10, 300)) -> dict:
    """下载成品视频字节（桥 base64 返回）。返回 {data(b64), filename, mime_type, size}。"""
    resp = requests.get(
        _BRIDGE_URL + "/video/download",
        params={"task_id": task_id},
        headers=_bridge_headers(), timeout=timeout,
    )
    if resp.status_code != 200:
        raise _parse_bridge_error(resp)
    return resp.json()


# ==================== 视频时长探测（ffprobe，信任插件 + 审计） ====================
def _ffprobe_path() -> str | None:
    """定位 ffprobe 可执行文件。

    优先级：
    1. 环境变量 LINGFANG_FFPROBE_PATH（桌面壳可显式注入内置 ffprobe 路径）
    2. PATH 中的 ffprobe/ffprobe.exe
    3. 桌面端内置 runtimes（相对插件目录向上找 apps/desktop/runtimes/ffmpeg）
    """
    # 1. 显式注入
    explicit = os.environ.get("LINGFANG_FFPROBE_PATH")
    if explicit and os.path.isfile(explicit):
        return explicit
    exe = "ffprobe.exe" if sys.platform == "win32" else "ffprobe"
    # 2. PATH 中查找
    found = shutil.which("ffprobe")
    if found:
        return found
    # 3. 桌面内置 runtimes（开发态：插件在 plugins/rbflow-video，内置在 apps/desktop/runtimes）
    candidates = [
        PLUGIN_DIR.parent.parent / "apps" / "desktop" / "runtimes" / "ffmpeg" / exe,
        PLUGIN_DIR / "runtimes" / "ffmpeg" / exe,
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def probe_duration_seconds(video_path: str) -> float:
    """用 ffprobe 探测视频时长（秒）。找不到 ffprobe 或探测失败抛异常（不静默兜底，避免计费不准）。"""
    ffprobe = _ffprobe_path()
    if not ffprobe:
        raise RuntimeError(
            "未找到 ffprobe（视频时长探测需要）。请在系统 PATH 安装 ffmpeg，"
            "或确保灵坊桌面端内置 runtimes 可用。"
        )
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            dur = float(result.stdout.strip())
            if dur > 0:
                return dur
        raise RuntimeError(f"ffprobe 返回异常（exit={result.returncode}）: {result.stderr.strip()[:200]}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("ffprobe 探测超时（15s）")
    except ValueError:
        raise RuntimeError(f"ffprobe 返回非数字时长: {result.stdout.strip()[:100]}")


# ==================== 任务模型 + 持久化 ====================
# 状态枚举（与 RBFLow v0.4 对齐 + 本地态）
STATE_PENDING = "PENDING"          # 已提交，等待 RBFLow worker
STATE_RUNNING = "RUNNING"          # 执行中
STATE_SUCCESS = "SUCCESS"          # 完成
STATE_FAILED = "FAILED"            # 失败
STATE_DOWNLOADING = "DOWNLOADING"  # 下载中
STATE_QUEUED = "QUEUED"            # RBFLow 已收单排队

# 用于状态筛选 tab 分组
FILTER_ALL = "全部"
FILTER_WAITING = "等待"
FILTER_RUNNING = "执行中"
FILTER_DONE = "完成"
FILTER_FAILED = "失败"

WAITING_STATES = {STATE_PENDING, STATE_QUEUED}


@dataclass
class Task:
    """单个视频生成任务（一对 image+video）。"""
    pair_id: str                       # 本地唯一 id
    image_path: str
    video_path: str
    seconds: float = 0.0               # 视频时长（计费用）
    tier: str = DEFAULT_TIER
    # 运行态
    rbflow_task_id: str = ""           # 桥返回的 RBFLow task_id
    call_log_id: str = ""             # 扣费票据
    charged_credits: float = 0.0
    state: str = STATE_PENDING
    progress: float = 0.0
    error_msg: str = ""
    saved_path: str = ""               # 落盘路径
    image_category: str = "默认"       # 图片分类（用于命名子目录）
    # 时间戳
    created_at: str = ""
    updated_at: str = ""
    finished_at: str = ""
    order: int = 0                    # 队列顺序

    def touch(self):
        self.updated_at = datetime.now().isoformat(timespec="seconds")


class TaskStore:
    """任务持久化（JSON 文件）。按 order 字段保序。"""

    def __init__(self, path: Path):
        self.path = path
        self.tasks: dict[str, Task] = {}
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for item in data.get("tasks", []):
                t = Task(**item)
                self.tasks[t.pair_id] = t
        except Exception as e:
            logging.error(f"加载任务列表失败: {e}")

    def save(self):
        ordered = sorted(self.tasks.values(), key=lambda t: t.order)
        data = {"tasks": [asdict(t) for t in ordered]}
        try:
            self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logging.error(f"保存任务列表失败: {e}")

    def add(self, task: Task):
        if not self.tasks:
            task.order = 0
        else:
            task.order = max(t.order for t in self.tasks.values()) + 1
        self.tasks[task.pair_id] = task
        self.save()

    def update(self, task: Task):
        task.touch()
        self.save()

    def remove(self, pair_id: str):
        self.tasks.pop(pair_id, None)
        self.save()

    def reorder(self, pair_ids: list):
        for i, pid in enumerate(pair_ids):
            if pid in self.tasks:
                self.tasks[pid].order = i
        self.save()

    def all_ordered(self) -> list:
        return sorted(self.tasks.values(), key=lambda t: t.order)


# ==================== 工作线程 ====================

class SubmitWorker(QThread):
    """笛卡尔积提交：逐对探测时长 → 扣灵石 → 提交 RBFLow。"""
    pair_submitted = Signal(object)   # Task
    pair_failed = Signal(str, str, object)  # pair_id, error_msg, partial Task (or None)
    billing_blocked = Signal(str)     # 余额不足消息
    finished_all = Signal(int, int)   # submitted_count, failed_count
    log = Signal(str)

    def __init__(self, pairs: list, tier: str, parent=None):
        # pairs: list of (image_path, video_path, image_category)
        super().__init__(parent)
        self.pairs = pairs
        self.tier = tier
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        submitted = 0
        failed = 0
        for img_path, vid_path, img_cat in self.pairs:
            if self._stop:
                break
            pair_id = f"{int(time.time() * 1000)}_{submitted}_{os.path.basename(img_path)[:8]}"
            task = Task(
                pair_id=pair_id, image_path=img_path, video_path=vid_path,
                seconds=0, tier=self.tier, image_category=img_cat,
                created_at=datetime.now().isoformat(timespec="seconds"),
            )
            task.touch()
            try:
                seconds = probe_duration_seconds(vid_path)
                task.seconds = seconds
                self.log.emit(f"提交 {os.path.basename(img_path)} × {os.path.basename(vid_path)}（{seconds:.0f}秒）...")
                result = bridge_submit_video(img_path, vid_path, seconds, self.tier)
                task.rbflow_task_id = result.get("task_id", "")
                task.call_log_id = result.get("call_log_id", "")
                task.charged_credits = float(result.get("credits", 0))
                task.state = STATE_PENDING
                submitted += 1
                self.pair_submitted.emit(task)
            except BridgeError as e:
                failed += 1
                if e.code == "insufficient_balance":
                    self.billing_blocked.emit(f"灵石余额不足，已停止提交（已完成 {submitted} 个）。请充值后重试。")
                    task.state = STATE_FAILED
                    task.error_msg = "灵石余额不足"
                    self.pair_failed.emit(pair_id, str(e), task)
                    break  # 余额不足，停止后续
                else:
                    task.state = STATE_FAILED
                    task.error_msg = str(e)
                    self.pair_failed.emit(pair_id, str(e), task)
            except Exception as e:
                failed += 1
                task.state = STATE_FAILED
                task.error_msg = str(e)
                self.pair_failed.emit(pair_id, str(e), task)
        self.finished_all.emit(submitted, failed)


class ProgressWorker(QThread):
    """单个任务的进度监听（轮询模式）。

    桥 /video/stream 一次性聚合返回 events 数组（非真正 SSE 流），且调用会阻塞到任务跑完。
    旧实现直接调 bridge_stream_video（默认 600s 读超时）→ 一直阻塞到终态才返回，前台一直显示「等待」。
    现改为短超时轮询：循环拉 events → 取最后一个 progress 更新 → 命中 done/error 即终止 → 否则 sleep 3s 再拉。
    """
    progress_update = Signal(str, float, str)   # pair_id, progress, state
    done = Signal(str, str)                      # pair_id, saved_info(json str)
    error = Signal(str, str)                     # pair_id, reason

    def __init__(self, pair_id: str, rbflow_task_id: str, parent=None):
        super().__init__(parent)
        self.pair_id = pair_id
        self.rbflow_task_id = rbflow_task_id
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        retries = 0
        max_retries = 5
        while not self._stop:
            try:
                # 短超时（连接 5s / 读 3s），让循环快速返回当前 events 而不阻塞到任务跑完
                events = bridge_stream_video(self.rbflow_task_id, timeout=(5, 3))
                last_prog = -1.0
                last_state = None
                terminal = False
                for ev in events:
                    if self._stop:
                        break
                    etype = ev.get("type", "")
                    if etype == "progress":
                        prog = float(ev.get("progress", 0))
                        state = ev.get("state", STATE_RUNNING)
                        last_prog = prog
                        last_state = state
                    elif etype == "done":
                        self.progress_update.emit(self.pair_id, 100.0, STATE_SUCCESS)
                        self.done.emit(self.pair_id, json.dumps(ev, ensure_ascii=False))
                        terminal = True
                        break
                    elif etype == "error":
                        reason = ev.get("reason") or ev.get("error_advice") or "生成失败"
                        self.error.emit(self.pair_id, reason)
                        terminal = True
                        break
                if terminal or self._stop:
                    return
                # 只在有 progress 事件时发一次最新进度（取最后一条）
                if last_prog >= 0:
                    self.progress_update.emit(self.pair_id, last_prog, last_state or STATE_RUNNING)
                retries = 0
                self.msleep(3000)
            except Exception as e:
                logging.warning(f"ProgressWorker {self.pair_id} 异常: {e}")
                retries += 1
                if retries > max_retries:
                    self.msleep(8000)
                else:
                    self.msleep(2000 * retries)


class _PollWorker(QThread):
    """一次性轮询线程：对一批非终态任务短超时拉一次 events，发回进度/终态信号。

    由 MainWindow 的自动刷新定时器（5s）和手动刷新按钮触发。与 ProgressWorker
    （长驻轮询）互补：ProgressWorker 单任务常驻；_PollWorker 批量兜底。
    """
    progress_update = Signal(str, float, str)   # pair_id, progress, state
    done = Signal(str, str)                      # pair_id, saved_info(json str)
    error = Signal(str, str)                     # pair_id, reason

    def __init__(self, tasks: list, parent=None):
        super().__init__(parent)
        # 只需 pair_id + rbflow_task_id
        self._tasks = [(t.pair_id, t.rbflow_task_id) for t in tasks]

    def run(self):
        for pair_id, rbflow_task_id in self._tasks:
            try:
                events = bridge_stream_video(rbflow_task_id, timeout=(5, 3))
                last_prog = -1.0
                last_state = None
                for ev in events:
                    etype = ev.get("type", "")
                    if etype == "progress":
                        last_prog = float(ev.get("progress", 0))
                        last_state = ev.get("state", STATE_RUNNING)
                    elif etype == "done":
                        self.progress_update.emit(pair_id, 100.0, STATE_SUCCESS)
                        self.done.emit(pair_id, json.dumps(ev, ensure_ascii=False))
                        break
                    elif etype == "error":
                        reason = ev.get("reason") or ev.get("error_advice") or "生成失败"
                        self.error.emit(pair_id, reason)
                        break
                else:
                    # 无终态事件：发最新进度（若有）
                    if last_prog >= 0:
                        self.progress_update.emit(pair_id, last_prog, last_state or STATE_RUNNING)
            except Exception as e:
                logging.warning(f"_PollWorker {pair_id} 异常: {e}")


# ==================== 自定义控件 ====================

class StatusBadge(QLabel):
    """状态色标圆点 + 文字。"""
    COLORS = {
        STATE_PENDING: "#f9e2af",
        STATE_QUEUED: "#f9e2af",
        STATE_RUNNING: "#89b4fa",
        STATE_DOWNLOADING: "#89b4fa",
        STATE_SUCCESS: "#a6e3a1",
        STATE_FAILED: "#f38ba8",
    }
    LABELS = {
        STATE_PENDING: "等待", STATE_QUEUED: "排队", STATE_RUNNING: "执行中",
        STATE_DOWNLOADING: "下载中", STATE_SUCCESS: "完成", STATE_FAILED: "失败",
    }

    def __init__(self, state: str = STATE_PENDING, parent=None):
        super().__init__(parent)
        self.set_state(state)

    def set_state(self, state: str):
        self._state = state
        color = self.COLORS.get(state, "#a6adc8")
        label = self.LABELS.get(state, state)
        self.setText(f"● {label}")
        self.setStyleSheet(f"color: {color}; font-size: 12px; font-weight: 500;")


class StatCard(QFrame):
    """统计卡片（数字 + 标签）。"""
    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self._title = QLabel(title, self)
        self._title.setObjectName("SectionLabel")
        self._num = QLabel("0", self)
        self._num.setStyleSheet("font-size: 20px; font-weight: 700; color: #cdd6f4;")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 8, 10, 8)
        lay.addWidget(self._title)
        lay.addWidget(self._num)

    def set_num(self, n: int):
        self._num.setText(str(n))


class TaskCardWidget(QWidget):
    """单个任务卡片控件（缩略图行 + 进度 + 状态 + 操作）。"""
    retry_clicked = Signal(str)
    delete_clicked = Signal(str)
    saveas_clicked = Signal(str)

    def __init__(self, task: Task, parent=None):
        super().__init__(parent)
        self.task = task
        self.setObjectName("TaskCard")
        self.setFixedHeight(96)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(8, 6, 8, 6)
        lay.setSpacing(8)

        # 缩略图（图片）
        self.thumb = QLabel(self)
        self.thumb.setFixedSize(72, 72)
        self.thumb.setStyleSheet("background-color: #11111b; border-radius: 6px; border: 1px solid #313244;")
        self.thumb.setAlignment(Qt.AlignCenter)
        self._load_thumb()
        lay.addWidget(self.thumb)

        # 信息列
        info = QVBoxLayout()
        info.setSpacing(2)
        self.name_label = QLabel(self._name_text(), self)
        self.name_label.setObjectName("TaskFilename")
        info.addWidget(self.name_label)

        self.meta_label = QLabel(self._meta_text(), self)
        self.meta_label.setObjectName("TaskMeta")
        info.addWidget(self.meta_label)

        self.progress = QProgressBar(self)
        self.progress.setFixedHeight(12)
        self.progress.setRange(0, 100)
        info.addWidget(self.progress)
        lay.addLayout(info, 1)

        # 状态 + 操作
        right = QVBoxLayout()
        right.setSpacing(4)
        self.badge = StatusBadge(task.state, self)
        right.addWidget(self.badge, alignment=Qt.AlignRight)

        ops = QHBoxLayout()
        ops.setSpacing(3)
        self.btn_retry = QPushButton("↻", self)
        self.btn_retry.setObjectName("CardBtnRetry")
        self.btn_retry.setFixedSize(30, 26)
        self.btn_retry.setToolTip("重新执行")
        self.btn_retry.clicked.connect(lambda: self.retry_clicked.emit(self.task.pair_id))
        self.btn_saveas = QPushButton("💾", self)
        self.btn_saveas.setObjectName("CardBtnSave")
        self.btn_saveas.setFixedSize(30, 26)
        self.btn_saveas.setToolTip("另存为")
        self.btn_saveas.clicked.connect(lambda: self.saveas_clicked.emit(self.task.pair_id))
        self.btn_del = QPushButton("✕", self)
        self.btn_del.setObjectName("CardBtnDelete")
        self.btn_del.setFixedSize(30, 26)
        self.btn_del.setToolTip("删除")
        self.btn_del.clicked.connect(lambda: self.delete_clicked.emit(self.task.pair_id))
        ops.addWidget(self.btn_retry)
        ops.addWidget(self.btn_saveas)
        ops.addWidget(self.btn_del)
        right.addLayout(ops)
        lay.addLayout(right)

        # 让选中灰色背景不贴到按钮区：卡片留底部 margin
        lay.setContentsMargins(8, 6, 8, 4)
        self.setAutoFillBackground(False)

        self._refresh_state()

    def _name_text(self):
        return f"{os.path.basename(self.task.image_path)} × {os.path.basename(self.task.video_path)}"

    def _meta_text(self):
        s = f"{self.task.seconds:.0f}秒 · {self.task.charged_credits:.1f}灵石"
        if self.task.saved_path:
            s += " · 已保存"
        elif self.task.error_msg:
            s += f" · {self.task.error_msg[:20]}"
        return s

    def _load_thumb(self):
        if not HAS_PIL:
            self.thumb.setText("🖼")
            return
        try:
            img = PILImage.open(self.task.image_path)
            img.thumbnail((72, 72))
            if img.mode != "RGBA":
                img = img.convert("RGBA")
            data = img.tobytes("raw", "RGBA")
            qimg = QImage(data, img.size[0], img.size[1], QImage.Format_RGBA8888)
            # 保持引用避免被 GC
            self._qimg = qimg
            pix = QPixmap.fromImage(qimg).scaled(
                72, 72, Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation,
            )
            self.thumb.setPixmap(pix)
        except Exception:
            self.thumb.setText("🖼")

    def _refresh_state(self):
        self.badge.set_state(self.task.state)
        prog = int(self.task.progress)
        if self.task.state == STATE_SUCCESS:
            prog = 100
        self.progress.setValue(prog)
        self.meta_label.setText(self._meta_text())
        # 操作按钮显隐
        self.btn_retry.setEnabled(self.task.state in (STATE_FAILED,))
        self.btn_saveas.setEnabled(bool(self.task.saved_path) or self.task.state == STATE_SUCCESS)

    def update_task(self, task: Task):
        self.task = task
        self._refresh_state()


# ==================== 左栏：图片输入面板 ====================

class ImagePanel(QFrame):
    """图片素材库：选图/选文件夹、分类、多选缩略图列表、全选/反选/删除/移动。

    素材列表持久化到 data/images.json（重启保留）。右键菜单：删除/置顶/移动分类。
    """
    images_changed = Signal()

    STORE_PATH = DATA_DIR / "images.json"

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self._items: list[dict] = []  # [{path, category}]
        self._categories = ["默认"]
        self._cur_category = "默认"
        self.image_dir = PLUGIN_DIR / "data" / "image"
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self._load_store()
        self._build_ui()
        self.refresh()

    # ---------- 持久化 ----------
    def _load_store(self):
        """加载持久化的素材列表 + 分类。"""
        try:
            if self.STORE_PATH.exists():
                data = json.loads(self.STORE_PATH.read_text(encoding="utf-8"))
                self._items = data.get("items", []) or []
                cats = data.get("categories", [])
                if cats:
                    self._categories = cats
                if self._cur_category not in self._categories:
                    self._cur_category = self._categories[0]
        except Exception as e:
            logging.error(f"加载图片素材库失败: {e}")

    def _save_store(self):
        """保存素材列表 + 分类。"""
        try:
            data = {"items": self._items, "categories": self._categories}
            self.STORE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logging.error(f"保存图片素材库失败: {e}")

    def _build_ui(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 10, 10, 10)
        lay.setSpacing(8)

        title = QLabel("📁 图片素材", self)
        title.setObjectName("PanelTitle")
        lay.addWidget(title)

        # 分类下拉
        cat_row = QHBoxLayout()
        cat_row.addWidget(QLabel("分类:", self))
        self.cat_combo = QComboBox(self)
        self.cat_combo.addItems(self._categories)
        self.cat_combo.currentTextChanged.connect(self._on_category_changed)
        cat_row.addWidget(self.cat_combo, 1)
        btn_new_cat = QPushButton("新建", self)
        btn_new_cat.clicked.connect(self._new_category)
        cat_row.addWidget(btn_new_cat)
        btn_refresh = QPushButton("⟳", self)
        btn_refresh.setObjectName("IconBtn")
        btn_refresh.setToolTip("刷新")
        btn_refresh.clicked.connect(self.refresh)
        cat_row.addWidget(btn_refresh)
        lay.addLayout(cat_row)

        # 选图按钮
        btn_row = QHBoxLayout()
        btn_pick = QPushButton("选择图片", self)
        btn_pick.clicked.connect(self._pick_images)
        btn_dir = QPushButton("选择文件夹", self)
        btn_dir.clicked.connect(self._pick_folder)
        btn_row.addWidget(btn_pick)
        btn_row.addWidget(btn_dir)
        lay.addLayout(btn_row)

        # 缩略图列表（图标模式 + 拖拽 + 多选 + 双击预览）
        self.list_widget = DropListWidget({".jpg", ".jpeg", ".png", ".webp", ".bmp"}, self)
        self.list_widget.setObjectName("ImageList")
        self.list_widget.setViewMode(QListWidget.IconMode)
        self.list_widget.setIconSize(QSize(90, 90))
        self.list_widget.setResizeMode(QListWidget.Adjust)
        self.list_widget.setMovement(QListWidget.Static)
        self.list_widget.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.list_widget.setSpacing(4)
        self.list_widget.setContextMenuPolicy(Qt.CustomContextMenu)
        self.list_widget.customContextMenuRequested.connect(self._show_context_menu)
        self.list_widget.files_dropped.connect(self._add_paths)
        self.list_widget.itemDoubleClicked.connect(self._preview_image)
        # checkbox 勾选变化时更新计数 + 底部信息栏
        self.list_widget.itemChanged.connect(lambda: (self._update_count() if hasattr(self, '_update_count') else None))
        lay.addWidget(self.list_widget, 1)

        # 工具行
        tools = QHBoxLayout()
        for label, slot in [("全选", self._select_all), ("反选", self._invert),
                            ("未选", self._select_none), ("删除", self._delete_selected),
                            ("移动", self._move_selected)]:
            b = QPushButton(label, self)
            b.clicked.connect(slot)
            tools.addWidget(b)
        lay.addLayout(tools)

        self._count_label = QLabel("0 张", self)
        self._count_label.setObjectName("HintLabel")
        lay.addWidget(self._count_label)

    def _on_category_changed(self, cat: str):
        self._cur_category = cat
        self.refresh()

    def _new_category(self):
        from PySide6.QtWidgets import QInputDialog
        name, ok = QInputDialog.getText(self, "新建分类", "分类名称:")
        if ok and name.strip() and name.strip() not in self._categories:
            self._categories.append(name.strip())
            self.cat_combo.addItem(name.strip())
            self.cat_combo.setCurrentText(name.strip())
            self._save_store()

    def _pick_images(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择图片", "", "图片文件 (*.jpg *.jpeg *.png *.webp *.bmp)"
        )
        if paths:
            self._add_paths(paths)

    def _pick_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "选择图片文件夹")
        if folder:
            exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
            paths = [str(p) for p in Path(folder).iterdir() if p.suffix.lower() in exts]
            if paths:
                self._add_paths(paths)

    def _add_paths(self, paths: list):
        for p in paths:
            if not any(it["path"] == p for it in self._items):
                self._items.append({"path": p, "category": self._cur_category})
        self._save_store()
        self.refresh()
        self.images_changed.emit()

    def _preview_image(self, item):
        """双击用系统默认图片查看器打开。"""
        path = item.data(Qt.UserRole)
        if path and os.path.isfile(path):
            QDesktopServices.openUrl(QUrl.fromLocalFile(path))

    def refresh(self):
        # 保留已勾选的 path（刷新后仍勾选）
        checked_paths = set()
        for i in range(self.list_widget.count()):
            it = self.list_widget.item(i)
            if it.checkState() == Qt.Checked:
                p = it.data(Qt.UserRole)
                if p:
                    checked_paths.add(p)
        self.list_widget.clear()
        cat_items = [it for it in self._items if it["category"] == self._cur_category]
        for it in cat_items:
            item = QListWidgetItem(os.path.basename(it["path"]))
            item.setToolTip(it["path"])
            item.setData(Qt.UserRole, it["path"])
            item.setCheckState(Qt.Checked if it["path"] in checked_paths else Qt.Unchecked)
            pix = self._make_thumb(it["path"])
            if pix:
                item.setIcon(QIcon(pix))
            self.list_widget.addItem(item)
        self._update_count()

    # ---------- 右键菜单 ----------
    def _show_context_menu(self, pos: QPoint):
        if not self.list_widget.itemAt(pos):
            return
        menu = QMenu(self)
        act_del = menu.addAction("删除选中")
        act_pin = menu.addAction("置顶选中")
        menu.addSeparator()
        act_move = menu.addAction("移动到分类…")
        chosen = menu.exec(self.list_widget.viewport().mapToGlobal(pos))
        if chosen is act_del:
            self._delete_selected()
        elif chosen is act_pin:
            self._pin_selected()
        elif chosen is act_move:
            self._move_selected()

    def _pin_selected(self):
        """把选中项移到当前分类列表顶部。"""
        paths = set(self._checked_paths())
        if not paths:
            return
        pinned = [it for it in self._items if it["path"] in paths]
        rest = [it for it in self._items if it["path"] not in paths]
        self._items = pinned + rest
        self._save_store()
        self.refresh()

    def _make_thumb(self, path: str) -> Optional[QPixmap]:
        if not HAS_PIL:
            return None
        try:
            img = PILImage.open(path)
            img.thumbnail((90, 90))
            if img.mode != "RGBA":
                img = img.convert("RGBA")
            data = img.tobytes("raw", "RGBA")
            qimg = QImage(data, img.size[0], img.size[1], QImage.Format_RGBA8888)
            return QPixmap.fromImage(qimg)
        except Exception:
            return None

    def _checked_paths(self) -> list:
        """返回勾选的图片路径（checkbox 模式）。"""
        return [self.list_widget.item(i).data(Qt.UserRole)
                for i in range(self.list_widget.count())
                if self.list_widget.item(i).checkState() == Qt.Checked]

    def _select_all(self):
        for i in range(self.list_widget.count()):
            self.list_widget.item(i).setCheckState(Qt.Checked)
        self._update_count()

    def _select_none(self):
        for i in range(self.list_widget.count()):
            self.list_widget.item(i).setCheckState(Qt.Unchecked)
        self._update_count()

    def _invert(self):
        for i in range(self.list_widget.count()):
            it = self.list_widget.item(i)
            it.setCheckState(Qt.Unchecked if it.checkState() == Qt.Checked else Qt.Checked)
        self._update_count()

    def _delete_selected(self):
        paths = set(self._checked_paths())
        self._items = [it for it in self._items if it["path"] not in paths]
        self._save_store()
        self.refresh()
        self.images_changed.emit()

    def _move_selected(self):
        paths = set(self._checked_paths())
        if not paths:
            return
        from PySide6.QtWidgets import QInputDialog
        items = [c for c in self._categories if c != self._cur_category]
        if not items:
            QMessageBox.information(self, "移动分类", "请先新建其他分类")
            return
        target, ok = QInputDialog.getItem(self, "移动到分类", "目标分类:", items, 0, False)
        if ok and target:
            for it in self._items:
                if it["path"] in paths:
                    it["category"] = target
            self._save_store()
            self.refresh()

    def _update_count(self):
        """更新计数 label（含已选数）。"""
        n = len([i for i in range(self.list_widget.count()) if self.list_widget.item(i).checkState() == Qt.Checked])
        total = self.list_widget.count()
        self._count_label.setText(f"已选 {n} / 共 {total} 张")

    def selected_items(self) -> list:
        """返回勾选图片的 [(path, category)]。"""
        sel = set(self._checked_paths())
        return [(it["path"], it["category"]) for it in self._items if it["path"] in sel]


# ==================== 中栏：参考视频面板 ====================

class VideoPanel(QFrame):
    """参考视频库。

    工作流节点配置（图片节点 78/image、视频节点 77/video）已写死为模块常量，桥
    forwardToRbflow 只认固定字段名 image/video，无需用户配置，故删除原节点配置 GroupBox。
    素材列表持久化到 data/videos.json（重启保留）。右键菜单：删除/置顶/移动分类。
    工具行：全选/反选/未选/删除/移动（与 ImagePanel 一致）。
    """
    videos_changed = Signal()

    STORE_PATH = DATA_DIR / "videos.json"

    def __init__(self, settings: QSettings, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self.settings = settings
        self._items: list[dict] = []
        self._categories = ["默认"]
        self._cur_category = "默认"
        self._load_store()
        self._build_ui()
        self.refresh()

    # ---------- 持久化 ----------
    def _load_store(self):
        try:
            if self.STORE_PATH.exists():
                data = json.loads(self.STORE_PATH.read_text(encoding="utf-8"))
                self._items = data.get("items", []) or []
                cats = data.get("categories", [])
                if cats:
                    self._categories = cats
                if self._cur_category not in self._categories:
                    self._cur_category = self._categories[0]
        except Exception as e:
            logging.error(f"加载视频素材库失败: {e}")

    def _save_store(self):
        try:
            data = {"items": self._items, "categories": self._categories}
            self.STORE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            logging.error(f"保存视频素材库失败: {e}")

    def _build_ui(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 10, 10, 10)
        lay.setSpacing(8)

        title = QLabel("🎬 参考视频", self)
        title.setObjectName("PanelTitle")
        lay.addWidget(title)

        # 分类行（含新建/刷新，与图片栏对齐）
        cat_row = QHBoxLayout()
        cat_row.addWidget(QLabel("分类:", self))
        self.cat_combo = QComboBox(self)
        self.cat_combo.addItems(self._categories)
        self.cat_combo.currentTextChanged.connect(self._on_category_changed)
        cat_row.addWidget(self.cat_combo, 1)
        btn_new_cat = QPushButton("新建", self)
        btn_new_cat.clicked.connect(self._new_category)
        cat_row.addWidget(btn_new_cat)
        btn_refresh = QPushButton("⟳", self)
        btn_refresh.setObjectName("IconBtn")
        btn_refresh.setToolTip("刷新")
        btn_refresh.clicked.connect(self.refresh)
        cat_row.addWidget(btn_refresh)
        lay.addLayout(cat_row)

        btn_row = QHBoxLayout()
        btn_pick = QPushButton("上传视频", self)
        btn_pick.clicked.connect(self._pick_videos)
        btn_dir = QPushButton("选择文件夹", self)
        btn_dir.clicked.connect(self._pick_folder)
        btn_row.addWidget(btn_pick)
        btn_row.addWidget(btn_dir)
        lay.addLayout(btn_row)

        self.list_widget = DropListWidget({".mp4", ".avi", ".mov", ".mkv", ".webm"}, self)
        self.list_widget.setObjectName("VideoList")
        # 和图片一样的大缩略图 IconMode
        self.list_widget.setViewMode(QListWidget.IconMode)
        self.list_widget.setIconSize(QSize(120, 80))
        self.list_widget.setResizeMode(QListWidget.Adjust)
        self.list_widget.setMovement(QListWidget.Static)
        self.list_widget.setSpacing(4)
        self.list_widget.setContextMenuPolicy(Qt.CustomContextMenu)
        self.list_widget.customContextMenuRequested.connect(self._show_context_menu)
        self.list_widget.files_dropped.connect(self._add_paths)
        # 双击预览视频（系统默认播放器）
        self.list_widget.itemDoubleClicked.connect(self._preview_video)
        # checkbox 勾选变化时更新计数 + 底部信息栏
        self.list_widget.itemChanged.connect(lambda: self._update_count() if hasattr(self, '_update_count') else None)
        lay.addWidget(self.list_widget, 1)

        # 工具行：全选/反选/未选/删除/移动
        tools = QHBoxLayout()
        for label, slot in [("全选", self._select_all), ("反选", self._invert),
                            ("未选", self._select_none), ("删除", self._delete_selected),
                            ("移动", self._move_selected)]:
            b = QPushButton(label, self)
            b.clicked.connect(slot)
            tools.addWidget(b)
        lay.addLayout(tools)

        self._count_label = QLabel("0 个", self)
        self._count_label.setObjectName("HintLabel")
        lay.addWidget(self._count_label)

    def _on_category_changed(self, cat: str):
        self._cur_category = cat
        self.refresh()

    def _new_category(self):
        from PySide6.QtWidgets import QInputDialog
        name, ok = QInputDialog.getText(self, "新建分类", "分类名称:")
        if ok and name.strip() and name.strip() not in self._categories:
            self._categories.append(name.strip())
            self.cat_combo.addItem(name.strip())
            self.cat_combo.setCurrentText(name.strip())
            self._save_store()

    def _pick_videos(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择视频", "", "视频文件 (*.mp4 *.avi *.mov *.mkv *.webm)"
        )
        if paths:
            self._add_paths(paths)

    def _pick_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "选择视频文件夹")
        if folder:
            exts = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
            paths = [str(p) for p in Path(folder).iterdir() if p.suffix.lower() in exts]
            if paths:
                self._add_paths(paths)

    def _add_paths(self, paths: list):
        for p in paths:
            if not any(it["path"] == p for it in self._items):
                self._items.append({"path": p, "category": self._cur_category})
        self._save_store()
        self.refresh()
        self.videos_changed.emit()

    # ---------- 拖拽添加 ----------
    _VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}

    def _drag_enter_event(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def _drag_move_event(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def _drop_event(self, event):
        paths = []
        for url in event.mimeData().urls():
            p = url.toLocalFile()
            if p and Path(p).suffix.lower() in self._VIDEO_EXTS:
                paths.append(p)
        if paths:
            self._add_paths(paths)
        event.acceptProposedAction()

    def _preview_video(self, item):
        """双击用系统默认播放器打开视频。"""
        path = item.data(Qt.UserRole)
        if path and os.path.isfile(path):
            QDesktopServices.openUrl(QUrl.fromLocalFile(path))

    def refresh(self):
        checked_paths = set()
        for i in range(self.list_widget.count()):
            it = self.list_widget.item(i)
            if it.checkState() == Qt.Checked:
                p = it.data(Qt.UserRole)
                if p:
                    checked_paths.add(p)
        self.list_widget.clear()
        cat_items = [it for it in self._items if it["category"] == self._cur_category]
        for it in cat_items:
            item = QListWidgetItem(f"📹 {os.path.basename(it['path'])}")
            item.setToolTip(it["path"])
            item.setData(Qt.UserRole, it["path"])
            item.setCheckState(Qt.Checked if it["path"] in checked_paths else Qt.Unchecked)
            # 生成视频缩略图（ffmpeg 提取第一帧）
            pix = self._make_video_thumb(it["path"])
            if pix:
                item.setIcon(QIcon(pix))
            self.list_widget.addItem(item)
        self._update_count()

    def _make_video_thumb(self, path: str) -> Optional[QPixmap]:
        """用 ffmpeg 提取视频第一帧作为缩略图。"""
        thumb_path = str(DATA_DIR / f"vthumb_{hash(path) & 0xFFFFFFFF}.jpg")
        if not os.path.exists(thumb_path):
            ffprobe = _ffprobe_path()
            ffmpeg = ffprobe.replace("ffprobe", "ffmpeg") if ffprobe else shutil.which("ffmpeg")
            if not ffmpeg:
                return None
            try:
                subprocess.run(
                    [ffmpeg, "-y", "-i", path, "-ss", "00:00:01", "-vframes", "1",
                     "-vf", "scale=120:80:force_original_aspect_ratio=decrease",
                     "-loglevel", "error", thumb_path],
                    timeout=15, capture_output=True,
                )
            except Exception:
                return None
        try:
            if os.path.exists(thumb_path):
                pix = QPixmap(thumb_path)
                if not pix.isNull():
                    return pix
        except Exception:
            pass
        return None

    def _checked_paths(self) -> list:
        return [self.list_widget.item(i).data(Qt.UserRole)
                for i in range(self.list_widget.count())
                if self.list_widget.item(i).checkState() == Qt.Checked]

    def _select_all(self):
        for i in range(self.list_widget.count()):
            self.list_widget.item(i).setCheckState(Qt.Checked)
        self._update_count()

    def _select_none(self):
        for i in range(self.list_widget.count()):
            self.list_widget.item(i).setCheckState(Qt.Unchecked)
        self._update_count()

    def _invert(self):
        for i in range(self.list_widget.count()):
            it = self.list_widget.item(i)
            it.setCheckState(Qt.Unchecked if it.checkState() == Qt.Checked else Qt.Checked)
        self._update_count()

    def _delete_selected(self):
        paths = set(self._checked_paths())
        self._items = [it for it in self._items if it["path"] not in paths]
        self._save_store()
        self.refresh()
        self.videos_changed.emit()

    def _move_selected(self):
        paths = set(self._checked_paths())
        if not paths:
            return
        from PySide6.QtWidgets import QInputDialog
        items = [c for c in self._categories if c != self._cur_category]
        if not items:
            QMessageBox.information(self, "移动分类", "请先新建其他分类")
            return
        target, ok = QInputDialog.getItem(self, "移动到分类", "目标分类:", items, 0, False)
        if ok and target:
            for it in self._items:
                if it["path"] in paths:
                    it["category"] = target
            self._save_store()
            self.refresh()

    def _update_count(self):
        n = len([i for i in range(self.list_widget.count()) if self.list_widget.item(i).checkState() == Qt.Checked])
        total = self.list_widget.count()
        self._count_label.setText(f"已选 {n} / 共 {total} 个")

    def selected_videos(self) -> list:
        sel = set(self._checked_paths())
        return [it["path"] for it in self._items if it["path"] in sel]

    # ---------- 右键菜单 ----------
    def _show_context_menu(self, pos: QPoint):
        if not self.list_widget.itemAt(pos):
            return
        menu = QMenu(self)
        act_del = menu.addAction("删除选中")
        act_pin = menu.addAction("置顶选中")
        menu.addSeparator()
        act_move = menu.addAction("移动到分类…")
        chosen = menu.exec(self.list_widget.viewport().mapToGlobal(pos))
        if chosen is act_del:
            self._delete_selected()
        elif chosen is act_pin:
            self._pin_selected()
        elif chosen is act_move:
            self._move_selected()

    def _pin_selected(self):
        paths = set(self._checked_paths())
        if not paths:
            return
        pinned = [it for it in self._items if it["path"] in paths]
        rest = [it for it in self._items if it["path"] not in paths]
        self._items = pinned + rest
        self._save_store()
        self.refresh()


# ==================== 右栏：任务队列面板 ====================

class QueuePanel(QFrame):
    """任务队列：统计、状态筛选 tab、自定义输出目录、任务卡片、批量操作。"""
    submit_requested = Signal(list, str)   # pairs, tier
    retry_task = Signal(str)               # pair_id
    delete_task = Signal(str)              # pair_id
    saveas_task = Signal(str)              # pair_id
    open_task = Signal(str)                # pair_id（双击打开已保存视频）
    reorder_requested = Signal(list)       # pair_ids in new order
    manual_refresh = Signal()              # 立即轮询所有非终态任务

    def __init__(self, store: TaskStore, settings: QSettings, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self.store = store
        self.settings = settings
        self._filter = FILTER_ALL
        self._card_widgets: dict[str, TaskCardWidget] = {}
        self._build_ui()
        self.refresh()

    def _build_ui(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 10, 10, 10)
        lay.setSpacing(8)

        title = QLabel("📋 任务队列", self)
        title.setObjectName("PanelTitle")
        lay.addWidget(title)

        # 统计卡片行
        stats = QHBoxLayout()
        stats.setSpacing(6)
        self.stat_total = StatCard("总计")
        self.stat_waiting = StatCard("等待")
        self.stat_running = StatCard("执行中")
        self.stat_done = StatCard("完成")
        self.stat_failed = StatCard("失败")
        for s in (self.stat_total, self.stat_waiting, self.stat_running, self.stat_done, self.stat_failed):
            stats.addWidget(s, 1)
        lay.addLayout(stats)

        # 状态筛选 tab
        self.tabs = QTabWidget(self)
        for name in (FILTER_ALL, FILTER_WAITING, FILTER_RUNNING, FILTER_DONE, FILTER_FAILED):
            tab = QWidget()
            self.tabs.addTab(tab, name)
        self.tabs.currentChanged.connect(self._on_tab_changed)
        lay.addWidget(self.tabs)

        # 输出目录
        out_row = QHBoxLayout()
        out_row.addWidget(QLabel("输出:", self))
        self.out_edit = QLineEdit(self.settings.value("output_dir", str(PLUGIN_DIR / "outputs")), self)
        out_row.addWidget(self.out_edit, 1)
        btn_browse = QPushButton("浏览", self)
        btn_browse.clicked.connect(self._browse_output)
        out_row.addWidget(btn_browse)
        lay.addLayout(out_row)

        # 任务列表
        self.list_widget = QListWidget(self)
        self.list_widget.setObjectName("TaskList")
        self.list_widget.setSelectionMode(QAbstractItemView.SingleSelection)
        self.list_widget.setDragDropMode(QAbstractItemView.InternalMove)
        self.list_widget.setDefaultDropAction(Qt.MoveAction)
        self.list_widget.model().rowsMoved.connect(self._on_rows_moved)
        # 双击任务卡片打开已保存的视频
        self.list_widget.itemDoubleClicked.connect(self._on_item_double_clicked)
        lay.addWidget(self.list_widget, 1)

        # 底部批量操作
        batch = QHBoxLayout()
        self.btn_manual_refresh = QPushButton("⟳ 立即刷新", self)
        self.btn_manual_refresh.setToolTip("立即轮询所有未完成任务的后台进度")
        self.btn_manual_refresh.clicked.connect(self.manual_refresh.emit)
        self.btn_clear_done = QPushButton("清除已完成", self)
        self.btn_clear_done.clicked.connect(self._clear_done)
        self.btn_del_all = QPushButton("清空全部", self)
        self.btn_del_all.setObjectName("DangerBtn")
        self.btn_del_all.clicked.connect(self._delete_all)
        self.chk_auto_retry = QCheckBox("自动重试", self)
        self.chk_auto_retry.setChecked(bool(self.settings.value("auto_retry", False, type=bool)))
        self.chk_auto_retry.toggled.connect(lambda v: self.settings.setValue("auto_retry", v))
        self.chk_auto_refresh = QCheckBox("自动刷新", self)
        self.chk_auto_refresh.setChecked(bool(self.settings.value("auto_refresh", True, type=bool)))
        self.chk_auto_refresh.toggled.connect(lambda v: self.settings.setValue("auto_refresh", v))
        batch.addWidget(self.chk_auto_retry)
        batch.addWidget(self.chk_auto_refresh)
        batch.addWidget(self.btn_manual_refresh)
        batch.addStretch()
        batch.addWidget(self.btn_clear_done)
        batch.addWidget(self.btn_del_all)
        lay.addLayout(batch)

    def _on_tab_changed(self, idx: int):
        self._filter = self.tabs.tabText(idx)
        self.refresh()

    def _browse_output(self):
        folder = QFileDialog.getExistingDirectory(self, "选择输出文件夹", self.out_edit.text())
        if folder:
            self.out_edit.setText(folder)
            self.settings.setValue("output_dir", folder)

    def output_dir(self) -> str:
        return self.out_edit.text().strip() or str(PLUGIN_DIR / "outputs")

    def auto_retry(self) -> bool:
        return self.chk_auto_retry.isChecked()

    def auto_refresh(self) -> bool:
        return self.chk_auto_refresh.isChecked()

    def _matches_filter(self, task: Task) -> bool:
        if self._filter == FILTER_ALL:
            return True
        if self._filter == FILTER_WAITING:
            return task.state in WAITING_STATES
        if self._filter == FILTER_RUNNING:
            return task.state in (STATE_RUNNING, STATE_DOWNLOADING)
        if self._filter == FILTER_DONE:
            return task.state == STATE_SUCCESS
        if self._filter == FILTER_FAILED:
            return task.state == STATE_FAILED
        return True

    def refresh(self):
        # 统计
        all_tasks = self.store.all_ordered()
        self.stat_total.set_num(len(all_tasks))
        self.stat_waiting.set_num(sum(1 for t in all_tasks if t.state in WAITING_STATES))
        self.stat_running.set_num(sum(1 for t in all_tasks if t.state in (STATE_RUNNING, STATE_DOWNLOADING)))
        self.stat_done.set_num(sum(1 for t in all_tasks if t.state == STATE_SUCCESS))
        self.stat_failed.set_num(sum(1 for t in all_tasks if t.state == STATE_FAILED))

        # 列表（重建以保持过滤 + 顺序）
        self.list_widget.clear()
        self._card_widgets.clear()
        for task in all_tasks:
            if not self._matches_filter(task):
                continue
            card = TaskCardWidget(task)
            card.retry_clicked.connect(self.retry_task.emit)
            card.delete_clicked.connect(self.delete_task.emit)
            card.saveas_clicked.connect(self.saveas_task.emit)
            item = QListWidgetItem()
            item.setSizeHint(card.sizeHint())
            item.setData(Qt.UserRole, task.pair_id)
            self.list_widget.addItem(item)
            self.list_widget.setItemWidget(item, card)

    def update_task_card(self, task: Task):
        """单任务更新（不重建整个列表，避免拖拽顺序丢失）。"""
        self.refresh()  # MVP：简单全刷；统计 + 过滤都要更新

    def _on_rows_moved(self):
        pair_ids = [self.list_widget.item(i).data(Qt.UserRole) for i in range(self.list_widget.count())]
        self.reorder_requested.emit(pair_ids)

    def _on_item_double_clicked(self, item):
        """双击任务卡片 → 打开已保存的视频。"""
        pair_id = item.data(Qt.UserRole)
        if pair_id:
            self.open_task.emit(pair_id)

    def _clear_done(self):
        done = [t.pair_id for t in self.store.all_ordered() if t.state == STATE_SUCCESS]
        for pid in done:
            self.store.remove(pid)
        self.refresh()

    def _delete_all(self):
        if not self.store.tasks:
            return
        if QMessageBox.question(self, "清空全部", f"确定删除全部 {len(self.store.tasks)} 个任务？") == QMessageBox.Yes:
            for pid in list(self.store.tasks.keys()):
                self.store.remove(pid)
            self.refresh()


# ==================== 提交进度悬浮窗 ====================

class SubmitProgressOverlay(QDialog):
    """提交时的非模态悬浮进度窗：显示提交进度（已提交/总数 + 当前操作 + 进度条）。

    提交完成后自动关闭（on_submit_finished 调 close()）。用户可手动关闭（不阻断提交线程）。
    """
    def __init__(self, total: int, parent=None):
        super().__init__(parent)
        self.setWindowTitle("提交中")
        self.setWindowFlags(Qt.Window | Qt.WindowTitleHint | Qt.WindowStaysOnTopHint | Qt.CustomizeWindowHint)
        self.setModal(False)
        self._total = total
        self._done = 0
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 16, 16, 16)
        lay.setSpacing(8)
        self.title_label = QLabel(f"正在提交 {total} 个任务...", self)
        self.title_label.setStyleSheet("font-size: 14px; font-weight: 600;")
        lay.addWidget(self.title_label)
        self.progress = QProgressBar(self)
        self.progress.setRange(0, total)
        self.progress.setValue(0)
        self.progress.setTextVisible(True)
        self.progress.setFormat(f"%v / {total}（%p%）")
        lay.addWidget(self.progress)
        self.detail_label = QLabel("准备中...", self)
        self.detail_label.setStyleSheet("color: gray; font-size: 12px;")
        self.detail_label.setWordWrap(True)
        lay.addWidget(self.detail_label)
        self.resize(360, 120)

    def update_step(self, msg: str):
        self.detail_label.setText(msg)

    def step_done(self):
        self._done += 1
        self.progress.setValue(self._done)
        self.title_label.setText(f"提交中... {self._done} / {self._total}")

    def finish(self, submitted: int, failed: int):
        self.title_label.setText(f"提交完成：成功 {submitted}，失败 {failed}")
        self.detail_label.setText("窗口将在 2 秒后自动关闭" if failed == 0 else "部分失败，详情见任务卡片")
        # 2 秒后自动关闭（成功时）；失败时保持让用户看到结果
        if failed == 0:
            from PySide6.QtCore import QTimer
            QTimer.singleShot(2000, self.close)


# ==================== 主窗口 ====================

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("动作迁移视频生成")
        self.resize(1500, 850)
        self.setMinimumSize(1200, 700)

        self.settings = QSettings("LingFang", "RbflowVideo")
        self.store = TaskStore(DATA_DIR / "tasks.json")
        self._submit_worker: Optional[SubmitWorker] = None
        self._progress_workers: dict[str, ProgressWorker] = {}

        # 主题状态（深色/亮色），记忆到 QSettings
        self._theme = self.settings.value("theme", THEME_DARK, type=str)
        if self._theme not in (THEME_DARK, THEME_LIGHT):
            self._theme = THEME_DARK

        # Windows 桌面通知托盘
        self.tray = QSystemTrayIcon(self)
        # 用自绘 pixmap 做托盘图标（避免依赖各平台 SP_ 枚举差异）
        _tray_pix = QPixmap(16, 16)
        _tray_pix.fill(QColor("#89b4fa"))
        self.tray.setIcon(QIcon(_tray_pix))
        self.tray.setToolTip("动作迁移视频生成")
        self.tray.show()

        self._build_ui()
        self._apply_theme()
        self._restore_geometry()
        self._refresh_status()

        # 恢复运行中任务的进度监听
        self._resume_progress()

        # 自动刷新定时器：每 5 秒轮询所有非终态任务（「自动刷新」勾选控制启停）
        self._refresh_timer = QTimer(self)
        self._refresh_timer.timeout.connect(self._auto_refresh_tick)
        self._refresh_timer.setInterval(5000)
        if self.queue_panel.auto_refresh():
            self._refresh_timer.start()

    def _build_ui(self):
        central = QWidget()
        central.setObjectName("CentralWidget")
        self.setCentralWidget(central)

        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(8)

        # 顶栏
        topbar = QFrame()
        topbar.setObjectName("TopBar")
        topbar.setFixedHeight(48)
        tlay = QHBoxLayout(topbar)
        tlay.setContentsMargins(12, 6, 12, 6)
        title = QLabel("🎬 动作迁移视频生成", topbar)
        title.setObjectName("AppTitle")
        tlay.addWidget(title)
        tlay.addStretch()
        self.status_label = QLabel("", topbar)
        self.status_label.setObjectName("StatusBadge")
        tlay.addWidget(self.status_label)
        tlay.addSpacing(16)

        # 主题切换按钮（深色 ☾ / 亮色 ☀）
        self.btn_theme = QPushButton("☀" if self._theme == THEME_DARK else "☾", topbar)
        self.btn_theme.setObjectName("ThemeToggle")
        self.btn_theme.setToolTip("切换深色/亮色主题")
        self.btn_theme.setFixedSize(40, 30)
        self.btn_theme.clicked.connect(self._toggle_theme)
        tlay.addWidget(self.btn_theme)

        # 档位
        self.tier_combo = QComboBox(topbar)
        self.tier_combo.addItems(TIER_CHOICES)
        self.tier_combo.setCurrentText(self.settings.value("tier", DEFAULT_TIER))
        self.tier_combo.currentTextChanged.connect(lambda v: self.settings.setValue("tier", v))
        tlay.addWidget(QLabel("档位:", topbar))
        tlay.addWidget(self.tier_combo)
        root.addWidget(topbar)

        # 三栏（用 QSplitter 支持拖拽调宽）
        splitter = QSplitter(Qt.Horizontal)
        self.image_panel = ImagePanel()
        self.video_panel = VideoPanel(self.settings)
        self.queue_panel = QueuePanel(self.store, self.settings)
        splitter.addWidget(self.image_panel)
        splitter.addWidget(self.video_panel)
        splitter.addWidget(self.queue_panel)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 4)
        splitter.setStretchFactor(2, 4)
        root.addWidget(splitter, 1)

        # 提交栏
        submit_bar = QHBoxLayout()
        self.info_label = QLabel("选 0 图 × 0 视频 = 0 任务", central)
        self.info_label.setObjectName("HintLabel")
        submit_bar.addWidget(self.info_label)
        submit_bar.addStretch()
        self.btn_submit = QPushButton("🚀 提交生成", central)
        self.btn_submit.setObjectName("PrimaryBtn")
        self.btn_submit.setMinimumWidth(140)
        self.btn_submit.clicked.connect(self._on_submit)
        submit_bar.addWidget(self.btn_submit)
        root.addLayout(submit_bar)

        # 信号连接
        self.image_panel.images_changed.connect(self._update_info)
        self.video_panel.videos_changed.connect(self._update_info)
        # checkbox 勾选变化时更新底部信息——否则勾了图/视频后数字不更新
        self.image_panel.list_widget.itemChanged.connect(self._update_info)
        self.video_panel.list_widget.itemChanged.connect(self._update_info)
        self.queue_panel.retry_task.connect(self._on_retry_task)
        self.queue_panel.delete_task.connect(self._on_delete_task)
        self.queue_panel.saveas_task.connect(self._on_saveas_task)
        self.queue_panel.open_task.connect(self._on_open_task)
        self.queue_panel.reorder_requested.connect(self.store.reorder)
        self.queue_panel.manual_refresh.connect(self._do_manual_refresh)
        # 「自动刷新」勾选变化时启停定时器
        self.queue_panel.chk_auto_refresh.toggled.connect(self._on_auto_refresh_toggled)

        self._update_info()
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)

    def _apply_theme(self):
        """根据 self._theme 生成 QSS 并应用。"""
        colors = DARK_COLORS if self._theme == THEME_DARK else LIGHT_COLORS
        try:
            self.setStyleSheet(build_qss(colors))
        except Exception as e:
            logging.error(f"应用主题失败: {e}")

    def _toggle_theme(self):
        self._theme = THEME_LIGHT if self._theme == THEME_DARK else THEME_DARK
        self.settings.setValue("theme", self._theme)
        self.btn_theme.setText("☀" if self._theme == THEME_DARK else "☾")
        self._apply_theme()

    def _on_auto_refresh_toggled(self, enabled: bool):
        if enabled:
            self._refresh_timer.start()
        else:
            self._refresh_timer.stop()

    def _do_manual_refresh(self):
        """手动刷新按钮：立即轮询所有非终态任务（同步，但每任务短超时）。"""
        self._poll_non_terminal_tasks()

    def _auto_refresh_tick(self):
        """定时器每 5 秒触发：轮询所有非终态任务。"""
        if not self.queue_panel.auto_refresh():
            return
        self._poll_non_terminal_tasks()

    def _poll_non_terminal_tasks(self):
        """对 PENDING/QUEUED/RUNNING/DOWNLOADING 任务调桥拉取最新进度。

        ProgressWorker 已是轮询模式；这里作为第二层兜底：覆盖刚启动尚未轮询到、
        或 worker 异常退出的任务。从 store 取最新状态避免与 worker 重复写终态。
        在独立线程执行，避免短超时阻塞 UI。
        """
        non_terminal = [
            t for t in self.store.all_ordered()
            if t.rbflow_task_id and t.state not in (STATE_SUCCESS, STATE_FAILED)
        ]
        if not non_terminal:
            return
        worker = _PollWorker(non_terminal, self)
        worker.progress_update.connect(self._on_progress_update)
        worker.done.connect(self._on_progress_done)
        worker.error.connect(self._on_progress_error)
        # 持有引用避免 GC（worker.run 完会发 finished）
        self._poll_worker = worker
        worker.finished.connect(lambda: setattr(self, "_poll_worker", None))
        worker.start()

    def _restore_geometry(self):
        geo = self.settings.value("geometry")
        if geo:
            self.restoreGeometry(geo)

    def closeEvent(self, event):
        self.settings.setValue("geometry", self.saveGeometry())
        # 停止所有 worker
        if self._submit_worker:
            self._submit_worker.stop()
            self._submit_worker.wait(3000)
        for w in self._progress_workers.values():
            w.stop()
            w.wait(3000)
        super().closeEvent(event)

    def _refresh_status(self):
        if bridge_ready():
            self.status_label.setText("● 已连接 · 按秒·灵石计费")
        else:
            self.status_label.setText("● 未连接平台桥（请在灵坊桌面端内运行）")
            self.status_label.setStyleSheet("color: #f38ba8; font-size: 12px;")

    def _update_info(self):
        imgs = self.image_panel.selected_items()
        vids = self.video_panel.selected_videos()
        n = len(imgs) * len(vids)
        # 预估时长：探测可能失败（ffprobe 缺失），失败时显示「时长未知」不崩 UI。
        try:
            total_sec = sum(probe_duration_seconds(v) for _, v in [(img, vid) for img in imgs for vid in vids])
            cost = total_sec * 0.5
            self.info_label.setText(
                f"选 {len(imgs)} 图 × {len(vids)} 视频 = {n} 任务 · 预计 {total_sec:.0f}秒 · 约 {cost:.1f} 灵石"
            )
        except Exception as e:
            self.info_label.setText(
                f"选 {len(imgs)} 图 × {len(vids)} 视频 = {n} 任务 · ⚠ 无法预估时长：{e}"
            )

    # ---------- 提交 ----------
    def _on_submit(self):
        if not bridge_ready():
            QMessageBox.warning(self, "未连接", "请在灵坊桌面端内运行本插件。")
            return
        imgs = self.image_panel.selected_items()
        vids = self.video_panel.selected_videos()
        if not imgs or not vids:
            QMessageBox.information(self, "未选择素材", "请至少选择 1 张图片和 1 个参考视频。")
            return

        pairs = [(img_path, vid, img_cat) for (img_path, img_cat) in imgs for vid in vids]
        n = len(pairs)
        # 预估总时长/灵石；探测失败时仍允许提交（SubmitWorker 会逐个探测并失败提示）。
        try:
            total_sec = sum(probe_duration_seconds(v) for _, v, _ in pairs)
            cost = total_sec * 0.5
            preview = f"将生成 {n} 个任务（共 {total_sec:.0f} 秒），预计消耗约 {cost:.1f} 灵石。"
        except Exception as e:
            preview = f"将生成 {n} 个任务。⚠ 无法预估时长（{e}），实际计费以各视频实际秒数为准。"
        if QMessageBox.question(self, "确认提交", preview + "\n继续？") != QMessageBox.Yes:
            return

        tier = self.tier_combo.currentText()
        self.btn_submit.setEnabled(False)
        self.btn_submit.setText("提交中...")
        # 提交进度悬浮窗
        self._submit_overlay = SubmitProgressOverlay(n, self)
        self._submit_overlay.show()
        self._submit_worker = SubmitWorker(pairs, tier, self)
        self._submit_worker.pair_submitted.connect(self._on_pair_submitted)
        self._submit_worker.pair_failed.connect(self._on_pair_failed)
        self._submit_worker.billing_blocked.connect(self._on_billing_blocked)
        self._submit_worker.finished_all.connect(self._on_submit_finished)
        self._submit_worker.log.connect(self._submit_overlay.update_step)
        self._submit_worker.start()

    def _on_pair_submitted(self, task: Task):
        self.store.add(task)
        self.queue_panel.refresh()
        # 启动该任务的进度监听
        self._start_progress(task)
        # 更新提交悬浮窗进度
        if hasattr(self, "_submit_overlay") and self._submit_overlay.isVisible():
            self._submit_overlay.step_done()

    def _on_pair_failed(self, pair_id: str, err: str, task):
        if task:
            task.state = STATE_FAILED
            task.error_msg = err
            self.store.add(task)
        self.queue_panel.refresh()
        logging.error(f"任务失败 {pair_id}: {err}")
        # 首个失败弹窗提示（避免每个失败都弹，批量时太吵）；后续失败汇总到状态栏。
        if not getattr(self, "_first_fail_shown", False):
            self._first_fail_shown = True
            QMessageBox.warning(self, "任务失败", f"生成失败：{err}\n\n详情见任务卡片，完整错误已写入 data/app.log")

    def _on_billing_blocked(self, msg: str):
        QMessageBox.warning(self, "余额不足", msg)

    def _on_submit_finished(self, submitted: int, failed: int):
        self.btn_submit.setEnabled(True)
        self.btn_submit.setText("🚀 提交生成")
        self._first_fail_shown = False  # 重置，下次提交再允许首失败弹窗
        # 关闭/完成提交悬浮窗
        if hasattr(self, "_submit_overlay") and self._submit_overlay.isVisible():
            self._submit_overlay.finish(submitted, failed)
        if failed > 0:
            # 有失败：状态栏持久红色提示（不自动消失）
            self.status_bar.setStyleSheet("color: #f38ba8;")
            self.status_bar.showMessage(f"⚠ 提交完成：成功 {submitted}，失败 {failed}（见任务卡片 / data/app.log）", 0)
        else:
            self.status_bar.setStyleSheet("")
            self.status_bar.showMessage(f"✓ 提交完成：{submitted} 个任务已加入队列", 5000)

    # ---------- 进度 ----------
    def _start_progress(self, task: Task):
        if not task.rbflow_task_id:
            return
        if task.pair_id in self._progress_workers:
            return
        w = ProgressWorker(task.pair_id, task.rbflow_task_id, self)
        w.progress_update.connect(self._on_progress_update)
        w.done.connect(self._on_progress_done)
        w.error.connect(self._on_progress_error)
        self._progress_workers[task.pair_id] = w
        w.start()

    def _resume_progress(self):
        """重启后恢复未完成任务的进度监听。"""
        for task in self.store.all_ordered():
            if task.rbflow_task_id and task.state not in (STATE_SUCCESS, STATE_FAILED):
                self._start_progress(task)

    def _on_progress_update(self, pair_id: str, progress: float, state: str):
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        task.progress = progress
        task.state = state
        self.store.update(task)
        self.queue_panel.update_task_card(task)

    def _on_progress_done(self, pair_id: str, info_json: str):
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        task.state = STATE_SUCCESS
        task.progress = 100.0
        task.finished_at = datetime.now().isoformat(timespec="seconds")
        self.store.update(task)
        self.queue_panel.update_task_card(task)
        # Windows 桌面通知：任务完成（生成阶段，下载在后续异步进行）
        self._notify_done(task)
        # 下载落盘
        self._download_and_save(task)

    def _notify_done(self, task: Task):
        """任务成功完成时弹 Windows 系统通知（QSystemTrayIcon）。"""
        try:
            name = f"{Path(task.image_path).stem}_{Path(task.video_path).stem}"
            self.tray.showMessage(
                "视频生成完成",
                f"{name} 已生成，正在保存到本地",
                QSystemTrayIcon.Information,
                5000,
            )
        except Exception as e:
            logging.warning(f"托盘通知失败: {e}")

    def _on_progress_error(self, pair_id: str, reason: str):
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        task.state = STATE_FAILED
        task.error_msg = reason
        task.finished_at = datetime.now().isoformat(timespec="seconds")
        self.store.update(task)
        self.queue_panel.update_task_card(task)
        # 进度阶段失败（任务跑了一半挂了）弹窗提示用户
        QMessageBox.warning(self, "生成失败", f"{os.path.basename(task.image_path)} × {os.path.basename(task.video_path)}\n失败原因：{reason}")
        if self.queue_panel.auto_retry():
            self._on_retry_task(pair_id)

    def _download_and_save(self, task: Task):
        """从桥下载成品视频并落盘到自定义文件夹。"""
        if not task.rbflow_task_id:
            return
        try:
            result = bridge_download_video(task.rbflow_task_id)
            data_b64 = result.get("data", "")
            filename = result.get("filename") or f"{os.path.basename(task.image_path)}_{os.path.basename(task.video_path)}.mp4"
            video_bytes = base64.b64decode(data_b64)

            # 命名模板：{输出目录}\{日期}\{图片分类}\{图片名}_{视频名}.mp4
            out_root = Path(self.queue_panel.output_dir())
            date_str = datetime.now().strftime("%Y-%-m-%-d") if sys.platform != "win32" else datetime.now().strftime("%Y-%#m-%#d")
            dest_dir = out_root / date_str / task.image_category
            dest_dir.mkdir(parents=True, exist_ok=True)
            base_img = Path(task.image_path).stem
            base_vid = Path(task.video_path).stem
            dest = dest_dir / f"{base_img}_{base_vid}.mp4"
            dest.write_bytes(video_bytes)

            task.saved_path = str(dest)
            task.state = STATE_SUCCESS
            self.store.update(task)
            self.queue_panel.update_task_card(task)
            self.status_bar.setStyleSheet("")
            self.status_bar.showMessage(f"✓ 已保存：{dest}", 5000)
        except Exception as e:
            logging.error(f"下载落盘失败 {task.pair_id}: {e}")
            task.error_msg = f"下载失败: {e}"
            self.store.update(task)
            self.queue_panel.update_task_card(task)
            QMessageBox.warning(self, "下载失败", f"视频已生成但保存失败：{e}\n\n可在任务卡片点「💾 另存为」重试。")

    # ---------- 卡片操作 ----------
    def _on_retry_task(self, pair_id: str):
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        # 重新提交（重新扣费 + 转发）
        pairs = [(task.image_path, task.video_path, task.image_category)]
        tier = task.tier
        worker = SubmitWorker(pairs, tier, self)
        worker.pair_submitted.connect(lambda new_task: (self.store.add(new_task), self._start_progress(new_task), self.queue_panel.refresh()))
        worker.pair_failed.connect(lambda pid, err, t: (self._on_pair_failed(pid, err, t)))
        worker.start()

    def _on_delete_task(self, pair_id: str):
        if pair_id in self._progress_workers:
            self._progress_workers[pair_id].stop()
            del self._progress_workers[pair_id]
        self.store.remove(pair_id)
        self.queue_panel.refresh()

    def _on_saveas_task(self, pair_id: str):
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        # 优先用已保存的文件；否则重新下载
        if task.saved_path and os.path.exists(task.saved_path):
            src = task.saved_path
        else:
            self._download_and_save(task)
            src = task.saved_path
        if not src or not os.path.exists(src):
            QMessageBox.warning(self, "无文件", "该任务暂无可保存的视频。")
            return
        dest, _ = QFileDialog.getSaveFileName(self, "另存为", os.path.basename(src), "视频 (*.mp4)")
        if dest:
            shutil.copy2(src, dest)
            self.status_bar.showMessage(f"已另存为：{dest}", 5000)

    def _on_open_task(self, pair_id: str):
        """双击任务卡片 → 用系统默认播放器打开已保存的视频。"""
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        # 优先用已保存的文件；否则先下载
        if not task.saved_path or not os.path.exists(task.saved_path):
            self._download_and_save(task)
        if task.saved_path and os.path.exists(task.saved_path):
            QDesktopServices.openUrl(QUrl.fromLocalFile(task.saved_path))
        else:
            QMessageBox.information(self, "暂无视频", "该任务还未生成视频，请等待完成。")


# ==================== 入口 ====================

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("RBFLow 视频生成")
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
