# -*- coding: utf-8 -*-
"""
RBFLow 创意工坊插件（PySide6 / Qt6）——视频动作迁移 + 音频声音克隆，顶部 Tab 切换。

功能：
  - 🎬 视频：上传参考图片 + 参考视频 → 笛卡尔积生成任务
      经平台桥 /video/generate 按视频时长（秒）扣灵石（PER_SECOND）
  - 🎙 音频：上传参考音频 + 目标文本 → 声音克隆任务
      经平台桥 /audio/generate 按输出音频估算秒数扣灵石（relay 从文本估算，防篡改）
  - 桥代理转发到平台运营的 RBFLow 实例（用户无凭证，防绕过）
  - 实时进度（经桥 /video/stream、/audio/stream 短轮询代理）
  - 完成后下载成品落盘到自定义文件夹（视频 mp4 / 音频 flac，支持日期/分类子目录）
  - 任务队列排序、状态筛选、批量操作、自动重试（视频/音频共享队列）

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
import threading
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field, fields, asdict
from typing import Optional

from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QWidget,
    QHBoxLayout,
    QVBoxLayout,
    QLabel,
    QPushButton,
    QLineEdit,
    QComboBox,
    QSpinBox,
    QListWidget,
    QListWidgetItem,
    QFileDialog,
    QProgressBar,
    QTabWidget,
    QCheckBox,
    QMessageBox,
    QSizePolicy,
    QFrame,
    QMenu,
    QAbstractItemView,
    QSplitter,
    QStatusBar,
    QDialog,
    QDialogButtonBox,
    QSystemTrayIcon,
    QStyledItemDelegate,
    QStyle,
    QStyleOption,
    QStyleOptionViewItem,
)
from PySide6.QtCore import (
    Qt,
    QThread,
    Signal,
    QSize,
    QTimer,
    QSettings,
    QMimeData,
    QPoint,
    QUrl,
    QObject,
    QEvent,
    QRect,
)
from PySide6.QtGui import (
    QPixmap,
    QImage,
    QAction,
    QIcon,
    QColor,
    QFont,
    QFontMetrics,
    QPainter,
    QPalette,
    QDragEnterEvent,
    QDropEvent,
    QDesktopServices,
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


# ==================== 文件拖拽：QListWidget 子类 + 面板级事件过滤器 ====================
# PySide6 的 Qt 事件分发走 C++ 虚函数表——直接赋值实例属性（self.list.dropEvent = ...）
# 不会被 Qt 调用。必须子类化并在类层级重写虚函数，Qt 才会正确分发。
#
# 两道保险，覆盖拖到列表内 / 拖到面板空白两种位置：
# 1) DropListWidget 子类重写 dragEnterEvent/dragMoveEvent/dropEvent——拖到列表视口
#    区域时由本类处理（标准做法）。
# 2) FileDropZone 事件过滤器装到面板（QFrame）上——拖到标题/按钮/空白区域也接受。
# 一次拖放只命中一个目标，_add_paths 自带去重，二者不会重复添加。
#
# 关键：dropEvent 用 QTimer.singleShot(0, ...) 延迟发出 files_dropped——否则同步
# 触发 _add_paths → refresh（含 ffmpeg 缩略图生成），会在 dropEvent 内部重建本
# widget，导致 Windows OLE 拖放看似无反应/卡死。


class DropListWidget(QListWidget):
    """支持从文件管理器拖拽文件添加的 QListWidget。
    子类化重写 dragEnterEvent/dragMoveEvent/dropEvent（PySide6 要求类层级重写，
    实例属性赋值无效）。回调 files_dropped(paths) 由面板实现。
    """

    files_dropped = Signal(list)  # list[str] of file paths

    def __init__(self, valid_exts: set, parent=None):
        super().__init__(parent)
        self._valid_exts = {e.lower() for e in valid_exts}
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DropOnly)
        self.setDefaultDropAction(Qt.CopyAction)
        # 视口也必须接受拖放——Windows OLE 拖放目标注册在视口上，
        # 某些 Qt6 构建仅 setAcceptDrops(self) 不够，拖入时视口仍不响应。
        self.viewport().setAcceptDrops(True)

    @staticmethod
    def _has_files(mime) -> bool:
        # 宽松判定：个别 Windows / PySide6 版本 hasUrls() 偶发返回 False 但 urls()
        # 非空（Explorer 拖入的 uri-list），故三者取或，确保都能被识别为文件拖放。
        try:
            return bool(
                mime.hasUrls() or mime.hasFormat("text/uri-list") or mime.urls()
            )
        except Exception:
            return bool(mime.urls())

    def dragEnterEvent(self, event):
        if self._has_files(event.mimeData()):
            event.setDropAction(Qt.CopyAction)
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event):
        if self._has_files(event.mimeData()):
            event.setDropAction(Qt.CopyAction)
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event):
        paths = []
        for url in event.mimeData().urls():
            p = url.toLocalFile()
            if p and Path(p).suffix.lower() in self._valid_exts:
                paths.append(p)
        # 必须先 accept，让拖放手势在视觉上立即结束；再延迟到事件循环空闲时
        # 处理 paths —— 否则 files_dropped 同步触发 _add_paths → refresh（含 ffmpeg
        # 缩略图生成），会在 dropEvent 内部重建本 widget，导致 Windows OLE 拖放
        # 看似无反应/卡死。
        event.acceptProposedAction()
        if paths:
            QTimer.singleShot(0, lambda p=paths: self.files_dropped.emit(p))


class FileDropZone(QObject):
    """事件过滤器：装到任意 QWidget（通常是面板 QFrame）上即可接受文件管理器拖拽。
    用于补 DropListWidget 之不足——拖到面板标题/按钮/空白区域也能添加文件。
    QListWidget 自身保留 DropOnly 处理其视口区域；二者只会命中其一。
    """

    files_dropped = Signal(list)  # list[str] of file paths

    def __init__(self, host, valid_exts: set):
        super().__init__(host)
        self._valid_exts = {e.lower() for e in valid_exts}
        self._host = host
        host.setAcceptDrops(True)
        host.installEventFilter(self)

    @staticmethod
    def _has_files(mime) -> bool:
        try:
            return bool(
                mime.hasUrls() or mime.hasFormat("text/uri-list") or mime.urls()
            )
        except Exception:
            return bool(mime.urls())

    def _collect(self, mime) -> list:
        paths = []
        for url in mime.urls():
            p = url.toLocalFile()
            if p and Path(p).suffix.lower() in self._valid_exts:
                paths.append(p)
        return paths

    def eventFilter(self, watched, event):
        t = event.type()
        if t == QEvent.DragEnter:
            if self._has_files(event.mimeData()):
                event.setDropAction(Qt.CopyAction)
                event.acceptProposedAction()
            else:
                event.ignore()
            return True
        if t == QEvent.DragMove:
            if self._has_files(event.mimeData()):
                event.acceptProposedAction()
            else:
                event.ignore()
            return True
        if t == QEvent.Drop:
            paths = self._collect(event.mimeData())
            event.acceptProposedAction()
            if paths:
                QTimer.singleShot(0, lambda p=paths: self.files_dropped.emit(p))
            return True
        return False


# ==================== 素材行代理：一行一个 [复选框][缩略图] 名字 / 上传时间 ====================
# index 数据角色：
#   PATH_ROLE = 文件路径（= Qt.UserRole，_checked_paths/_preview 直接复用）
#   TIME_ROLE = 上传时间字符串 "YYYY-MM-DD HH:MM"
#   PIX_ROLE  = QPixmap 缩略图（可能为 None → 绘制占位）
# 复选框/选中/hover/双击/右键菜单 全部由 QListView 原生事件处理，代理只画——
# 不用 setItemWidget（会与复选框重叠、吞鼠标事件），也不用多行文本（默认代理
# 走 TextSingleLine，"\n" 不换行）。

PATH_ROLE = Qt.UserRole  # 文件路径
TIME_ROLE = Qt.UserRole + 1  # 上传时间字符串
PIX_ROLE = Qt.UserRole + 2  # QPixmap 缩略图


def _format_added_time(it: dict, path: str) -> str:
    """显示「上传时间」：优先 item.added_at，其次文件 mtime，再退化为 '—'。
    旧素材库无 added_at 字段，用文件修改时间近似。"""
    ts = it.get("added_at")
    if not ts:
        try:
            ts = datetime.fromtimestamp(os.path.getmtime(path)).isoformat(
                timespec="minutes"
            )
        except Exception:
            return "—"
    try:
        return datetime.fromisoformat(ts).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "—"


class AssetRowDelegate(QStyledItemDelegate):
    """素材行绘制代理。

    一行一项布局：[复选框] [缩略图]  右侧：名字（粗体）/ 上传时间（淡色小字）。
    复选框与背景由 QStyle::drawControl(CE_ItemViewItem) 绘制——与 QListView
    点击命中复选框的判定一致，勾选/双击/右键/选择均由视图原生处理，本类只画。
    """

    def __init__(self, thumb_w: int = 72, thumb_h: int = 72, parent=None):
        super().__init__(parent)
        self._tw = thumb_w
        self._th = thumb_h

    def sizeHint(self, option, index):
        return QSize(120, self._th + 10)

    def paint(self, painter: QPainter, option, index):
        painter.save()
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        style = opt.widget.style() if opt.widget else QApplication.style()
        # 清空文字/图标，让 drawControl 只画背景 + 复选框
        opt.text = ""
        opt.icon = QIcon()
        style.drawControl(QStyle.CE_ItemViewItem, opt, painter, opt.widget)

        rect = option.rect
        cb_w = style.pixelMetric(QStyle.PM_IndicatorWidth, opt, opt.widget)
        x0 = rect.left() + cb_w + 12  # 跳过复选框

        th, tw = self._th, self._tw
        pix_rect = QRect(x0, rect.top() + (rect.height() - th) // 2, tw, th)
        pix = index.data(PIX_ROLE)
        if isinstance(pix, QPixmap) and not pix.isNull():
            scaled = pix.scaled(tw, th, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            painter.drawPixmap(
                QRect(
                    pix_rect.left() + (tw - scaled.width()) // 2,
                    pix_rect.top() + (th - scaled.height()) // 2,
                    scaled.width(),
                    scaled.height(),
                ),
                scaled,
            )
        else:
            painter.setPen(Qt.NoPen)
            painter.setBrush(opt.palette.color(QPalette.AlternateBase))
            painter.drawRoundedRect(pix_rect, 4, 4)
            painter.setPen(opt.palette.color(QPalette.PlaceholderText))
            painter.drawText(pix_rect, Qt.AlignCenter, "📁")

        tx = pix_rect.right() + 8
        twa = max(20, rect.right() - tx - 6)
        name = os.path.basename(str(index.data(PATH_ROLE) or ""))
        ts = str(index.data(TIME_ROLE) or "")

        block_h = 20 + 1 + 16
        ty = rect.top() + max(0, (rect.height() - block_h) // 2)

        f = QFont(painter.font())
        f.setBold(True)
        painter.setFont(f)
        painter.setPen(opt.palette.color(QPalette.Active, QPalette.Text))
        painter.drawText(
            QRect(tx, ty, twa, 20),
            Qt.AlignLeft | Qt.AlignVCenter,
            QFontMetrics(f).elidedText(name, Qt.ElideRight, twa),
        )
        ps = f.pointSize()
        f2 = QFont(f)
        f2.setBold(False)
        f2.setPointSize(max(8, (ps - 1) if ps > 0 else 9))
        painter.setFont(f2)
        painter.setPen(opt.palette.color(QPalette.Disabled, QPalette.Text))
        painter.drawText(
            QRect(tx, ty + 21, twa, 16),
            Qt.AlignLeft | Qt.AlignVCenter,
            QFontMetrics(f2).elidedText(ts, Qt.ElideRight, twa),
        )
        painter.restore()


# ==================== 主题调色板 + QSS 模板 ====================
# QSS 不支持变量，这里用 Python dict + f-string 模板动态生成深色/亮色样式表。

DARK_COLORS = {
    "base": "#1e1e2e",  # 主背景
    "mantle": "#181825",  # 面板/顶栏
    "crust": "#11111b",  # 输入框/列表底
    "surface0": "#313244",  # 按钮底
    "surface1": "#45475a",  # hover
    "surface2": "#585b70",
    "overlay0": "#6c7086",  # 次要文字
    "overlay1": "#7f849c",
    "overlay2": "#9399b2",
    "subtext0": "#a6adc8",
    "text": "#cdd6f4",  # 主文字
    "blue": "#89b4fa",  # 强调色
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

    return 'url("data:image/svg+xml,' + urllib.parse.quote(svg) + '")'


def build_qss(c: dict) -> str:
    """根据配色 dict 生成完整 QSS 字符串。"""
    return f"""\
/* === RBFLow 视频生成插件 · 动态主题（{"暗色" if c is DARK_COLORS else "亮色"}） === */

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
QLineEdit, QComboBox, QSpinBox, QPlainTextEdit {{
    background-color: {c["crust"]};
    border: 1px solid {c["surface0"]};
    border-radius: 6px;
    padding: 5px 8px;
    color: {c["text"]};
    selection-background-color: {c["blue"]};
    selection-color: {c["base"]};
}}
QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus {{ border-color: {c["blue"]}; }}
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
        return BridgeError(
            f"桥错误 {resp.status_code}: {resp.text[:200]}", status=resp.status_code
        )


def bridge_submit_video(
    image_path: str,
    video_path: str,
    seconds: float,
    tier: str = DEFAULT_TIER,
    timeout=(30, 120),
) -> dict:
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
        json=body,
        headers=_bridge_headers(),
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise _parse_bridge_error(resp)
    return resp.json()


def bridge_stream_video(task_id: str, timeout=(10, 600), kind: str = "video") -> list:
    """拉取任务进度事件（桥聚合返回 events 数组）。每个 event 是 dict。

    kind: "video" → /video/stream；"audio" → /audio/stream（RBFLow 任务状态机两者同构）。
    事件类型（RBFLow v0.4）：
      progress: {type, progress, node, node_progress, state}
      done:     {type, progress, state, file_url, local_path, filename}
      error:    {type, state, reason, error_code, error_advice}
    """
    endpoint = "/audio/stream" if kind == "audio" else "/video/stream"
    resp = requests.get(
        _BRIDGE_URL + endpoint,
        params={"task_id": task_id},
        headers=_bridge_headers(),
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise _parse_bridge_error(resp)
    data = resp.json()
    return data.get("events", [])


def bridge_download_video(task_id: str, timeout=(10, 300), kind: str = "video") -> dict:
    """下载成品字节（桥 base64 返回）。返回 {data(b64), filename, mime_type, size}。

    kind: "video" → /video/download；"audio" → /audio/download。
    """
    endpoint = "/audio/download" if kind == "audio" else "/video/download"
    resp = requests.get(
        _BRIDGE_URL + endpoint,
        params={"task_id": task_id},
        headers=_bridge_headers(),
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise _parse_bridge_error(resp)
    return resp.json()


def bridge_submit_audio(
    audio_path: str,
    prompt_text: str,
    tier: str = DEFAULT_TIER,
    timeout=(30, 120),
) -> dict:
    """提交一个声音克隆任务（参考音频 + 目标文本）。返回 {task_id, call_log_id, charged, credits, seconds}。

    桥先按「输出音频估算秒数」扣灵石（relay 从 prompt_text 估算，插件不传 seconds），
    再代理转发到 RBFLow /tasks/voice。余额不足(402)抛 BridgeError(code=insufficient_balance)。
    """
    with open(audio_path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode()

    body = {
        "audio": audio_b64,
        "audio_filename": os.path.basename(audio_path),
        "prompt_text": prompt_text,
        "model": tier,
    }
    resp = requests.post(
        _BRIDGE_URL + "/audio/generate",
        json=body,
        headers=_bridge_headers(),
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise _parse_bridge_error(resp)
    return resp.json()


# ==================== 声音克隆：输出音频秒数估算（中文语速启发式） ====================
# 与 relay estimateVoiceSeconds 同一公式：插件做提交前预估，relay 做权威计费，二者一致。
# 改这里必须同步改 relay.service.ts 的 VOICE_CHARS_PER_SECOND，否则预估≠实扣。
VOICE_CHARS_PER_SECOND = 4
# 目标文本上限（字符），与 relay VOICE_MAX_PROMPT_CHARS / RBFLow _MAX_PROMPT_TEXT 对齐。
VOICE_MAX_PROMPT_CHARS = 5000


def estimate_voice_seconds(prompt_text: str) -> int:
    """由目标文本长度估算输出音频秒数（向上取整，≥1 秒）。与 relay 计费公式一致。"""
    import math

    return max(1, math.ceil(len(prompt_text.strip()) / VOICE_CHARS_PER_SECOND))

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


_DURATION_CACHE: dict[str, float] = {}
"""path -> 视频时长（秒）。由后台线程探测填充，避免在 UI 勾选时同步 spawn
ffprobe 导致卡顿。SubmitWorker / _update_info 均优先读缓存。"""


def cached_duration(video_path: str) -> Optional[float]:
    """仅读缓存，绝不 spawn ffprobe。供 UI（_update_info）使用，保证勾选瞬时响应。"""
    return _DURATION_CACHE.get(video_path)


def probe_duration_seconds(video_path: str) -> float:
    """用 ffprobe 探测视频时长（秒）。找不到 ffprobe 或探测失败抛异常（不静默兜底，避免计费不准）。

    成功后写入 _DURATION_CACHE，后续 UI 可直接读缓存。应在后台线程调用
    （SubmitWorker / _DurationAssetsGenWorker），不要在 UI 事件处理中同步调用。
    """
    cached = _DURATION_CACHE.get(video_path)
    if cached is not None:
        return cached
    ffprobe = _ffprobe_path()
    if not ffprobe:
        raise RuntimeError(
            "未找到 ffprobe（视频时长探测需要）。请在系统 PATH 安装 ffmpeg，"
            "或确保灵坊桌面端内置 runtimes 可用。"
        )
    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            dur = float(result.stdout.strip())
            if dur > 0:
                _DURATION_CACHE[video_path] = dur
                return dur
        raise RuntimeError(
            f"ffprobe 返回异常（exit={result.returncode}）: {result.stderr.strip()[:200]}"
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("ffprobe 探测超时（15s）")
    except ValueError:
        raise RuntimeError(f"ffprobe 返回非数字时长: {result.stdout.strip()[:100]}")


def _unique_dest_path(dest_dir: Path, stem: str, ext: str = ".mp4") -> Path:
    """返回 dest_dir 下不会覆盖已有文件的目标路径。

    若 {stem}{ext} 已存在，则依次尝试 {stem}_1{ext}、{stem}_2{ext}……
    直到找到一个尚未存在的文件名，避免覆盖之前输出的同名视频。
    """
    candidate = dest_dir / f"{stem}{ext}"
    n = 1
    while candidate.exists():
        candidate = dest_dir / f"{stem}_{n}{ext}"
        n += 1
    return candidate


# ==================== 任务模型 + 持久化 ====================
# 状态枚举（与 RBFLow v0.4 对齐 + 本地态）
STATE_PENDING = "PENDING"  # 已提交，等待 RBFLow worker
STATE_RUNNING = "RUNNING"  # 执行中
STATE_SUCCESS = "SUCCESS"  # 完成
STATE_FAILED = "FAILED"  # 失败
STATE_DOWNLOADING = "DOWNLOADING"  # 下载中
STATE_QUEUED = "QUEUED"  # RBFLow 已收单排队

# 用于状态筛选 tab 分组
FILTER_ALL = "全部"
FILTER_WAITING = "等待"
FILTER_RUNNING = "执行中"
FILTER_DONE = "完成"
FILTER_FAILED = "失败"

WAITING_STATES = {STATE_PENDING, STATE_QUEUED}


@dataclass
class Task:
    """单个工作流任务。

    kind="video"：动作迁移（image_path + video_path 笛卡尔积一对）。
    kind="audio"：声音克隆（audio_path 参考音频 + prompt_text 目标文本）。
    """

    pair_id: str  # 本地唯一 id
    image_path: str = ""  # 视频工作流：参考图片
    video_path: str = ""  # 视频工作流：参考视频
    seconds: float = 0.0  # 计费用秒数（视频=探测时长；音频=文本估算）
    tier: str = DEFAULT_TIER
    kind: str = "video"  # "video" | "audio"
    # 音频工作流专用
    audio_path: str = ""  # 参考音频
    prompt_text: str = ""  # 目标文本（克隆语音要说的内容）
    # 运行态
    rbflow_task_id: str = ""  # 桥返回的 RBFLow task_id
    call_log_id: str = ""  # 扣费票据
    charged_credits: float = 0.0
    state: str = STATE_PENDING
    progress: float = 0.0
    error_msg: str = ""
    saved_path: str = ""  # 落盘路径
    image_category: str = "默认"  # 图片分类（用于命名子目录）
    # 时间戳
    created_at: str = ""
    updated_at: str = ""
    finished_at: str = ""
    order: int = 0  # 队列顺序
    # 自动重试
    retry_count: int = 0  # 已自动重试次数
    next_retry_at: str = ""  # 下次自动重试时间（ISO）；空=无待重试

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
        # 只取 Task 已知字段：老数据无新字段（kind/audio_path/prompt_text）走默认值，
        # 未来新增字段也不会因老版本读到多余 key 而崩溃。
        known = {f.name for f in fields(Task)}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            for item in data.get("tasks", []):
                t = Task(**{k: v for k, v in item.items() if k in known})
                self.tasks[t.pair_id] = t
        except Exception as e:
            logging.error(f"加载任务列表失败: {e}")

    def save(self):
        ordered = sorted(self.tasks.values(), key=lambda t: t.order)
        data = {"tasks": [asdict(t) for t in ordered]}
        try:
            self.path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
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

    pair_submitted = Signal(object)  # Task
    pair_failed = Signal(str, str, object, bool)  # pair_id, error_msg, partial Task, retryable
    billing_blocked = Signal(str)  # 余额不足消息
    finished_all = Signal(int, int)  # submitted_count, failed_count
    log = Signal(str)

    def __init__(self, pairs: list, tier: str, pair_id: str = "", parent=None):
        # pairs: list of (image_path, video_path, image_category)
        # pair_id：非空时复用该 id（原任务就地重试用），否则生成新 id
        super().__init__(parent)
        self.pairs = pairs
        self.tier = tier
        self._pair_id = pair_id
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        submitted = 0
        failed = 0
        for img_path, vid_path, img_cat in self.pairs:
            if self._stop:
                break
            pair_id = self._pair_id or f"{int(time.time() * 1000)}_{submitted}_{os.path.basename(img_path)[:8]}"
            task = Task(
                pair_id=pair_id,
                image_path=img_path,
                video_path=vid_path,
                seconds=0,
                tier=self.tier,
                image_category=img_cat,
                created_at=datetime.now().isoformat(timespec="seconds"),
            )
            task.touch()
            try:
                seconds = probe_duration_seconds(vid_path)
                task.seconds = seconds
                self.log.emit(
                    f"提交 {os.path.basename(img_path)} × {os.path.basename(vid_path)}（{seconds:.0f}秒）..."
                )
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
                    self.billing_blocked.emit(
                        f"灵石余额不足，已停止提交（已完成 {submitted} 个）。请充值后重试。"
                    )
                    task.state = STATE_FAILED
                    task.error_msg = "灵石余额不足"
                    self.pair_failed.emit(pair_id, str(e), task, False)  # 余额不足不可重试
                    break  # 余额不足，停止后续
                else:
                    task.state = STATE_FAILED
                    task.error_msg = str(e)
                    self.pair_failed.emit(pair_id, str(e), task, True)
            except Exception as e:
                failed += 1
                task.state = STATE_FAILED
                task.error_msg = str(e)
                self.pair_failed.emit(pair_id, str(e), task, True)
        self.finished_all.emit(submitted, failed)


class VoiceSubmitWorker(QThread):
    """声音克隆提交：探测参考音频时长（仅展示）→ 扣灵石（relay 按文本估算秒数）→ 提交 RBFLow /tasks/voice。

    与 SubmitWorker 区别：单个参考音频 + 目标文本（非笛卡尔积）；计费秒数由 relay 从
    prompt_text 估算，插件仅用 estimate_voice_seconds 做提交前预估展示。
    """

    pair_submitted = Signal(object)  # Task
    pair_failed = Signal(str, str, object, bool)  # pair_id, error_msg, partial Task, retryable
    billing_blocked = Signal(str)  # 余额不足消息
    finished_all = Signal(int, int)  # submitted_count, failed_count
    log = Signal(str)

    def __init__(self, audio_path: str, prompt_text: str, tier: str, pair_id: str = "", parent=None):
        super().__init__(parent)
        self.audio_path = audio_path
        self.prompt_text = prompt_text
        self.tier = tier
        self._pair_id = pair_id  # 非空时复用（原任务就地重试）
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        submitted = 0
        failed = 0
        if self._stop:
            self.finished_all.emit(0, 0)
            return
        pair_id = self._pair_id or f"{int(time.time() * 1000)}_voice_{os.path.basename(self.audio_path)[:8]}"
        est_seconds = estimate_voice_seconds(self.prompt_text)
        task = Task(
            pair_id=pair_id,
            kind="audio",
            audio_path=self.audio_path,
            prompt_text=self.prompt_text,
            seconds=est_seconds,
            tier=self.tier,
            created_at=datetime.now().isoformat(timespec="seconds"),
        )
        task.touch()
        try:
            self.log.emit(
                f"提交声音克隆 {os.path.basename(self.audio_path)}（约{est_seconds}秒）..."
            )
            result = bridge_submit_audio(self.audio_path, self.prompt_text, self.tier)
            task.rbflow_task_id = result.get("task_id", "")
            task.call_log_id = result.get("call_log_id", "")
            task.charged_credits = float(result.get("credits", 0))
            # relay 返回权威估算秒数（与插件公式一致），回填任务供展示。
            task.seconds = float(result.get("seconds", est_seconds))
            task.state = STATE_PENDING
            submitted += 1
            self.pair_submitted.emit(task)
        except BridgeError as e:
            failed += 1
            if e.code == "insufficient_balance":
                self.billing_blocked.emit("灵石余额不足，提交已取消。请充值后重试。")
                task.state = STATE_FAILED
                task.error_msg = "灵石余额不足"
                self.pair_failed.emit(pair_id, str(e), task, False)  # 余额不足不可重试
            else:
                task.state = STATE_FAILED
                task.error_msg = str(e)
                self.pair_failed.emit(pair_id, str(e), task, True)
        except Exception as e:
            failed += 1
            task.state = STATE_FAILED
            task.error_msg = str(e)
            self.pair_failed.emit(pair_id, str(e), task, True)
        self.finished_all.emit(submitted, failed)


class ProgressWorker(QThread):
    """单个任务的进度监听（轮询模式）。

    桥 /video/stream 一次性聚合返回 events 数组（非真正 SSE 流），且调用会阻塞到任务跑完。
    旧实现直接调 bridge_stream_video（默认 600s 读超时）→ 一直阻塞到终态才返回，前台一直显示「等待」。
    现改为短超时轮询：循环拉 events → 取最后一个 progress 更新 → 命中 done/error 即终止 → 否则 sleep 3s 再拉。
    """

    progress_update = Signal(str, float, str)  # pair_id, progress, state
    done = Signal(str, str)  # pair_id, saved_info(json str)
    error = Signal(str, str)  # pair_id, reason

    def __init__(self, pair_id: str, rbflow_task_id: str, kind: str = "video", parent=None):
        super().__init__(parent)
        self.pair_id = pair_id
        self.rbflow_task_id = rbflow_task_id
        self.kind = kind  # "video" | "audio"：决定走 /video/stream 还是 /audio/stream
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        retries = 0
        max_retries = 5
        while not self._stop:
            try:
                # 短超时（连接 5s / 读 3s），让循环快速返回当前 events 而不阻塞到任务跑完
                events = bridge_stream_video(self.rbflow_task_id, timeout=(5, 3), kind=self.kind)
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
                        reason = (
                            ev.get("reason") or ev.get("error_advice") or "生成失败"
                        )
                        self.error.emit(self.pair_id, reason)
                        terminal = True
                        break
                if terminal or self._stop:
                    return
                # 只在有 progress 事件时发一次最新进度（取最后一条）
                if last_prog >= 0:
                    self.progress_update.emit(
                        self.pair_id, last_prog, last_state or STATE_RUNNING
                    )
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

    progress_update = Signal(str, float, str)  # pair_id, progress, state
    done = Signal(str, str)  # pair_id, saved_info(json str)
    error = Signal(str, str)  # pair_id, reason

    def __init__(self, tasks: list, parent=None):
        super().__init__(parent)
        # 只需 pair_id + rbflow_task_id + kind（视频/音频走不同 stream 端点）
        self._tasks = [(t.pair_id, t.rbflow_task_id, t.kind) for t in tasks]

    def run(self):
        for pair_id, rbflow_task_id, kind in self._tasks:
            try:
                events = bridge_stream_video(rbflow_task_id, timeout=(5, 3), kind=kind)
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
                        reason = (
                            ev.get("reason") or ev.get("error_advice") or "生成失败"
                        )
                        self.error.emit(pair_id, reason)
                        break
                else:
                    # 无终态事件：发最新进度（若有）
                    if last_prog >= 0:
                        self.progress_update.emit(
                            pair_id, last_prog, last_state or STATE_RUNNING
                        )
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
        STATE_PENDING: "等待",
        STATE_QUEUED: "排队",
        STATE_RUNNING: "执行中",
        STATE_DOWNLOADING: "下载中",
        STATE_SUCCESS: "完成",
        STATE_FAILED: "失败",
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
        self.thumb.setStyleSheet(
            "background-color: #11111b; border-radius: 6px; border: 1px solid #313244;"
        )
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
        self.btn_retry.clicked.connect(
            lambda: self.retry_clicked.emit(self.task.pair_id)
        )
        self.btn_saveas = QPushButton("💾", self)
        self.btn_saveas.setObjectName("CardBtnSave")
        self.btn_saveas.setFixedSize(30, 26)
        self.btn_saveas.setToolTip("另存为")
        self.btn_saveas.clicked.connect(
            lambda: self.saveas_clicked.emit(self.task.pair_id)
        )
        self.btn_del = QPushButton("✕", self)
        self.btn_del.setObjectName("CardBtnDelete")
        self.btn_del.setFixedSize(30, 26)
        self.btn_del.setToolTip("删除")
        self.btn_del.clicked.connect(
            lambda: self.delete_clicked.emit(self.task.pair_id)
        )
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
        if self.task.kind == "audio":
            return f"🎙 {os.path.basename(self.task.audio_path or '音频')} · 声音克隆"
        return f"{os.path.basename(self.task.image_path)} × {os.path.basename(self.task.video_path)}"

    def _meta_text(self):
        if self.task.kind == "audio":
            snippet = self.task.prompt_text.strip().replace("\n", " ")[:18]
            s = f"约{self.task.seconds:.0f}秒 · {self.task.charged_credits:.1f}灵石 · {snippet}"
        else:
            s = f"{self.task.seconds:.0f}秒 · {self.task.charged_credits:.1f}灵石"
        if self.task.retry_count:
            s += f" · 重试{self.task.retry_count}次"
        if self.task.state == STATE_FAILED and self.task.next_retry_at:
            # 已安排自动重试：显示下次重试时间（等待中）
            s += f" · 待重试({self.task.next_retry_at[11:19]})"
        elif self.task.saved_path:
            s += " · 已保存"
        elif self.task.error_msg:
            s += f" · {self.task.error_msg[:20]}"
        return s

    def _load_thumb(self):
        # 音频任务无图片缩略图，显示麦克风图标。
        if self.task.kind == "audio":
            self.thumb.setText("🎙")
            return
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
                72,
                72,
                Qt.KeepAspectRatioByExpanding,
                Qt.SmoothTransformation,
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
        self.btn_saveas.setEnabled(
            bool(self.task.saved_path) or self.task.state == STATE_SUCCESS
        )

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
            self.STORE_PATH.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
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

        # 素材列表：一行一个 [复选框][缩略图] 名字/上传时间（AssetRowDelegate 绘制）
        self.list_widget = DropListWidget(
            {".jpg", ".jpeg", ".png", ".webp", ".bmp"}, self
        )
        self.list_widget.setObjectName("ImageList")
        self.list_widget.setViewMode(QListWidget.ListMode)
        self.list_widget.setUniformItemSizes(True)
        self.list_widget.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.list_widget.setItemDelegate(AssetRowDelegate(72, 72, self.list_widget))
        self.list_widget.setContextMenuPolicy(Qt.CustomContextMenu)
        self.list_widget.customContextMenuRequested.connect(self._show_context_menu)
        self.list_widget.files_dropped.connect(self._add_paths)
        # 面板级拖拽兜底：拖到标题/按钮/空白区域也接受（列表自身处理视口区域）
        self._drop_zone = FileDropZone(self, {".jpg", ".jpeg", ".png", ".webp", ".bmp"})
        self._drop_zone.files_dropped.connect(self._add_paths)
        self.list_widget.itemDoubleClicked.connect(self._preview_image)
        # checkbox 勾选变化时更新计数 + 底部信息栏
        self.list_widget.itemChanged.connect(
            lambda: self._update_count() if hasattr(self, "_update_count") else None
        )
        lay.addWidget(self.list_widget, 1)

        # 工具行
        tools = QHBoxLayout()
        for label, slot in [
            ("全选", self._select_all),
            ("反选", self._invert),
            ("未选", self._select_none),
            ("删除", self._delete_selected),
            ("移动", self._move_selected),
        ]:
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
        now = datetime.now().isoformat(timespec="minutes")
        for p in paths:
            if not any(it["path"] == p for it in self._items):
                self._items.append(
                    {"path": p, "category": self._cur_category, "added_at": now}
                )
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
                p = it.data(PATH_ROLE)
                if p:
                    checked_paths.add(p)
        # 重建期间阻塞信号：每个 setCheckState 都会触发 itemChanged → _update_count
        # （O(N)），N 个项重建即 O(N²)；block 后只在末尾 _update_count 一次。
        self.list_widget.blockSignals(True)
        self.list_widget.clear()
        cat_items = [it for it in self._items if it["category"] == self._cur_category]
        for it in cat_items:
            item = QListWidgetItem()
            item.setToolTip(it["path"])
            item.setData(PATH_ROLE, it["path"])
            item.setData(TIME_ROLE, _format_added_time(it, it["path"]))
            item.setData(PIX_ROLE, self._make_thumb(it["path"]))
            item.setCheckState(
                Qt.Checked if it["path"] in checked_paths else Qt.Unchecked
            )
            self.list_widget.addItem(item)
        self.list_widget.blockSignals(False)
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
        return [
            self.list_widget.item(i).data(Qt.UserRole)
            for i in range(self.list_widget.count())
            if self.list_widget.item(i).checkState() == Qt.Checked
        ]

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
            it.setCheckState(
                Qt.Unchecked if it.checkState() == Qt.Checked else Qt.Checked
            )
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
        target, ok = QInputDialog.getItem(
            self, "移动到分类", "目标分类:", items, 0, False
        )
        if ok and target:
            for it in self._items:
                if it["path"] in paths:
                    it["category"] = target
            self._save_store()
            self.refresh()

    def _update_count(self):
        """更新计数 label（含已选数）。"""
        n = len(
            [
                i
                for i in range(self.list_widget.count())
                if self.list_widget.item(i).checkState() == Qt.Checked
            ]
        )
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
    durations_ready = Signal()
    """后台线程完成时长探测 + 缩略图生成后发出（跨线程 queued 到主线程），
    MainWindow 据此刷新视频列表图标 + 预估信息。"""

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
        # 启动时若历史视频有时长/缩略图未生成，后台补齐
        self._kick_off_assets([it["path"] for it in self._items])

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
            self.STORE_PATH.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
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

        self.list_widget = DropListWidget(
            {".mp4", ".avi", ".mov", ".mkv", ".webm"}, self
        )
        self.list_widget.setObjectName("VideoList")
        # 素材列表：一行一个 [复选框][缩略图] 名字/上传时间（AssetRowDelegate 绘制）
        self.list_widget.setViewMode(QListWidget.ListMode)
        self.list_widget.setUniformItemSizes(True)
        self.list_widget.setItemDelegate(AssetRowDelegate(96, 54, self.list_widget))
        self.list_widget.setContextMenuPolicy(Qt.CustomContextMenu)
        self.list_widget.customContextMenuRequested.connect(self._show_context_menu)
        self.list_widget.files_dropped.connect(self._add_paths)
        # 面板级拖拽兜底：拖到标题/按钮/空白区域也接受（列表自身处理视口区域）
        self._drop_zone = FileDropZone(self, {".mp4", ".avi", ".mov", ".mkv", ".webm"})
        self._drop_zone.files_dropped.connect(self._add_paths)
        # 双击预览视频（系统默认播放器）
        self.list_widget.itemDoubleClicked.connect(self._preview_video)
        # 参考视频唯一：勾选任一项即取消其他（radio 行为）+ 更新计数
        self.list_widget.itemChanged.connect(self._on_item_changed)
        lay.addWidget(self.list_widget, 1)

        # 工具行：参考视频为单选，去掉「全选/反选」（语义不适用），保留 未选/删除/移动
        tools = QHBoxLayout()
        for label, slot in [
            ("未选", self._select_none),
            ("删除", self._delete_selected),
            ("移动", self._move_selected),
        ]:
            b = QPushButton(label, self)
            b.clicked.connect(slot)
            tools.addWidget(b)
        tools.addStretch()
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
        new_paths = []
        now = datetime.now().isoformat(timespec="minutes")
        for p in paths:
            if not any(it["path"] == p for it in self._items):
                self._items.append(
                    {"path": p, "category": self._cur_category, "added_at": now}
                )
                new_paths.append(p)
        self._save_store()
        self.refresh()
        self.videos_changed.emit()
        # 后台生成缩略图 + 探测时长（填充缓存），完成后刷新列表图标 + 预估信息
        if new_paths:
            self._kick_off_assets(new_paths)

    # ---------- 后台资源生成（缩略图 + 时长） ----------
    def _kick_off_assets(self, paths: list):
        """启动后台线程：为给定视频生成缩略图文件 + 探测时长入缓存。

        线程内只做文件 I/O 与 subprocess（无 Qt 对象操作），完成后跨线程 emit
        durations_ready（自动 queued 到主线程）。threading 模块在运行期间会
        持有线程引用，无需手动保活。
        """
        todo = [
            p
            for p in paths
            if (p not in _DURATION_CACHE)
            or not os.path.exists(str(DATA_DIR / f"vthumb_{hash(p) & 0xFFFFFFFF}.jpg"))
        ]
        if not todo:
            return

        def _worker():
            ffmpeg = None
            for p in todo:
                # 时长
                if p not in _DURATION_CACHE:
                    try:
                        probe_duration_seconds(p)
                    except Exception as e:
                        logging.error(f"探测时长失败 {p}: {e}")
                # 缩略图（仅当文件不存在才生成，避免重复跑 ffmpeg）
                thumb_path = str(DATA_DIR / f"vthumb_{hash(p) & 0xFFFFFFFF}.jpg")
                if not os.path.exists(thumb_path):
                    if ffmpeg is None:
                        ffprobe = _ffprobe_path()
                        ffmpeg = (
                            ffprobe.replace("ffprobe", "ffmpeg")
                            if ffprobe
                            else shutil.which("ffmpeg")
                        )
                    if ffmpeg:
                        try:
                            subprocess.run(
                                [
                                    ffmpeg,
                                    "-y",
                                    "-i",
                                    p,
                                    "-ss",
                                    "00:00:01",
                                    "-vframes",
                                    "1",
                                    "-vf",
                                    "scale=120:80:force_original_aspect_ratio=decrease",
                                    "-loglevel",
                                    "error",
                                    thumb_path,
                                ],
                                timeout=20,
                                capture_output=True,
                            )
                        except Exception as e:
                            logging.error(f"生成缩略图失败 {p}: {e}")
            self.durations_ready.emit()

        t = threading.Thread(target=_worker, daemon=True)
        t.start()

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
                p = it.data(PATH_ROLE)
                if p:
                    checked_paths.add(p)
        # 重建期间阻塞信号：setCheckState 会触发 itemChanged → _on_item_changed，
        # 后者会取消其他勾选（radio 行为），在重建循环中引发级联与错误取消。
        self.list_widget.blockSignals(True)
        self.list_widget.clear()
        cat_items = [it for it in self._items if it["category"] == self._cur_category]
        for it in cat_items:
            item = QListWidgetItem()
            item.setToolTip(it["path"])
            item.setData(PATH_ROLE, it["path"])
            item.setData(TIME_ROLE, _format_added_time(it, it["path"]))
            item.setData(PIX_ROLE, self._load_video_thumb(it["path"]))
            item.setCheckState(
                Qt.Checked if it["path"] in checked_paths else Qt.Unchecked
            )
            self.list_widget.addItem(item)
        self.list_widget.blockSignals(False)
        self._update_count()

    def _load_video_thumb(self, path: str) -> Optional[QPixmap]:
        """加载已生成的缩略图文件（不生成、不 spawn ffmpeg）。文件不存在返回 None。"""
        thumb_path = str(DATA_DIR / f"vthumb_{hash(path) & 0xFFFFFFFF}.jpg")
        if not os.path.exists(thumb_path):
            return None
        try:
            pix = QPixmap(thumb_path)
            if not pix.isNull():
                return pix
        except Exception:
            pass
        return None

    def _checked_paths(self) -> list:
        return [
            self.list_widget.item(i).data(Qt.UserRole)
            for i in range(self.list_widget.count())
            if self.list_widget.item(i).checkState() == Qt.Checked
        ]

    def _on_item_changed(self, item: QListWidgetItem):
        """参考视频唯一选择（radio 行为）。

        勾选任一项 → 取消其余项（blockSignals 防止取消时再次触发本槽形成级联）。
        取消勾选不强制保留某个——允许「全不选」状态（用户可先清空再选）。
        """
        if item.checkState() == Qt.Checked:
            self.list_widget.blockSignals(True)
            for i in range(self.list_widget.count()):
                other = self.list_widget.item(i)
                if other is not item and other.checkState() == Qt.Checked:
                    other.setCheckState(Qt.Unchecked)
            self.list_widget.blockSignals(False)
        self._update_count()
        self.videos_changed.emit()

    def _select_none(self):
        self.list_widget.blockSignals(True)
        for i in range(self.list_widget.count()):
            self.list_widget.item(i).setCheckState(Qt.Unchecked)
        self.list_widget.blockSignals(False)
        self._update_count()
        self.videos_changed.emit()

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
        target, ok = QInputDialog.getItem(
            self, "移动到分类", "目标分类:", items, 0, False
        )
        if ok and target:
            for it in self._items:
                if it["path"] in paths:
                    it["category"] = target
            self._save_store()
            self.refresh()

    def _update_count(self):
        n = len(
            [
                i
                for i in range(self.list_widget.count())
                if self.list_widget.item(i).checkState() == Qt.Checked
            ]
        )
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

    submit_requested = Signal(list, str)  # pairs, tier
    retry_task = Signal(str)  # pair_id
    delete_task = Signal(str)  # pair_id
    saveas_task = Signal(str)  # pair_id
    open_task = Signal(str)  # pair_id（双击打开已保存视频）
    reorder_requested = Signal(list)  # pair_ids in new order
    manual_refresh = Signal()  # 立即轮询所有非终态任务

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
        for s in (
            self.stat_total,
            self.stat_waiting,
            self.stat_running,
            self.stat_done,
            self.stat_failed,
        ):
            stats.addWidget(s, 1)
        lay.addLayout(stats)

        # 状态筛选 tab
        self.tabs = QTabWidget(self)
        for name in (
            FILTER_ALL,
            FILTER_WAITING,
            FILTER_RUNNING,
            FILTER_DONE,
            FILTER_FAILED,
        ):
            tab = QWidget()
            self.tabs.addTab(tab, name)
        self.tabs.currentChanged.connect(self._on_tab_changed)
        lay.addWidget(self.tabs)

        # 输出目录
        out_row = QHBoxLayout()
        out_row.addWidget(QLabel("输出:", self))
        self.out_edit = QLineEdit(
            self.settings.value("output_dir", str(PLUGIN_DIR / "outputs")), self
        )
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
        self.chk_auto_retry.setChecked(
            bool(self.settings.value("auto_retry", False, type=bool))
        )
        self.chk_auto_retry.toggled.connect(
            lambda v: self.settings.setValue("auto_retry", v)
        )
        # 自动重试上限（次）：同一任务最多重试 N 次，超过则取消（保持失败）
        self.spin_max_retry = QSpinBox(self)
        self.spin_max_retry.setRange(0, 20)
        self.spin_max_retry.setValue(int(self.settings.value("max_retry", 3)))
        self.spin_max_retry.setToolTip("同一任务最多自动重试次数，超过则取消（0=不重试）")
        self.spin_max_retry.valueChanged.connect(
            lambda v: self.settings.setValue("max_retry", v)
        )
        # 自动重试间隔（秒）：失败后等待多久再重试
        self.spin_retry_interval = QSpinBox(self)
        self.spin_retry_interval.setRange(5, 3600)
        self.spin_retry_interval.setSingleStep(5)
        self.spin_retry_interval.setValue(int(self.settings.value("retry_interval", 30)))
        self.spin_retry_interval.setToolTip("失败后等待多少秒再自动重试")
        self.spin_retry_interval.valueChanged.connect(
            lambda v: self.settings.setValue("retry_interval", v)
        )
        self.chk_auto_refresh = QCheckBox("自动刷新", self)
        self.chk_auto_refresh.setChecked(
            bool(self.settings.value("auto_refresh", True, type=bool))
        )
        self.chk_auto_refresh.toggled.connect(
            lambda v: self.settings.setValue("auto_refresh", v)
        )
        batch.addWidget(self.chk_auto_retry)
        batch.addWidget(QLabel("上限", self))
        batch.addWidget(self.spin_max_retry)
        batch.addWidget(QLabel("间隔秒", self))
        batch.addWidget(self.spin_retry_interval)
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
        folder = QFileDialog.getExistingDirectory(
            self, "选择输出文件夹", self.out_edit.text()
        )
        if folder:
            self.out_edit.setText(folder)
            self.settings.setValue("output_dir", folder)

    def output_dir(self) -> str:
        return self.out_edit.text().strip() or str(PLUGIN_DIR / "outputs")

    def auto_retry(self) -> bool:
        return self.chk_auto_retry.isChecked()

    def max_retry(self) -> int:
        return self.spin_max_retry.value()

    def retry_interval(self) -> int:
        return self.spin_retry_interval.value()

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
        self.stat_waiting.set_num(
            sum(1 for t in all_tasks if t.state in WAITING_STATES)
        )
        self.stat_running.set_num(
            sum(1 for t in all_tasks if t.state in (STATE_RUNNING, STATE_DOWNLOADING))
        )
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
        pair_ids = [
            self.list_widget.item(i).data(Qt.UserRole)
            for i in range(self.list_widget.count())
        ]
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
        if (
            QMessageBox.question(
                self, "清空全部", f"确定删除全部 {len(self.store.tasks)} 个任务？"
            )
            == QMessageBox.Yes
        ):
            for pid in list(self.store.tasks.keys()):
                self.store.remove(pid)
            self.refresh()


# ==================== 音频工作流：参考音频面板 + 目标文本面板 ====================


class AudioRefPanel(QFrame):
    """参考音频库（声音克隆）：上传/拖放单个参考音频，单选。

    与 VideoPanel 类似但更轻：声音克隆一次只用一个参考音频 + 一段目标文本。
    素材列表持久化到 data/audios.json（重启保留）。勾选任一项即取消其余（radio）。
    """

    audio_changed = Signal()

    STORE_PATH = DATA_DIR / "audios.json"
    AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self._items: list[str] = []  # 音频路径列表
        self._load_store()
        self._build_ui()
        self.refresh()

    # ---------- 持久化 ----------
    def _load_store(self):
        try:
            if self.STORE_PATH.exists():
                data = json.loads(self.STORE_PATH.read_text(encoding="utf-8"))
                self._items = data.get("items", []) or []
        except Exception as e:
            logging.error(f"加载音频素材库失败: {e}")

    def _save_store(self):
        try:
            self.STORE_PATH.write_text(
                json.dumps({"items": self._items}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logging.error(f"保存音频素材库失败: {e}")

    def _build_ui(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 10, 10, 10)
        lay.setSpacing(8)

        title = QLabel("🎙 参考音频", self)
        title.setObjectName("PanelTitle")
        lay.addWidget(title)

        hint = QLabel("上传一段清晰的人声作参考（决定克隆音色）", self)
        hint.setObjectName("HintLabel")
        hint.setWordWrap(True)
        lay.addWidget(hint)

        btn_row = QHBoxLayout()
        btn_pick = QPushButton("上传音频", self)
        btn_pick.clicked.connect(self._pick_audio)
        btn_row.addWidget(btn_pick)
        btn_del = QPushButton("删除选中", self)
        btn_del.clicked.connect(self._delete_selected)
        btn_row.addWidget(btn_del)
        btn_row.addStretch()
        lay.addLayout(btn_row)

        self.list_widget = DropListWidget(self.AUDIO_EXTS, self)
        self.list_widget.setObjectName("AudioList")
        self.list_widget.files_dropped.connect(self._add_paths)
        self._drop_zone = FileDropZone(self, self.AUDIO_EXTS)
        self._drop_zone.files_dropped.connect(self._add_paths)
        self.list_widget.itemChanged.connect(self._on_item_changed)
        # 双击预览（系统默认播放器）
        self.list_widget.itemDoubleClicked.connect(self._preview_audio)
        lay.addWidget(self.list_widget, 1)

        self._count_label = QLabel("0 个", self)
        self._count_label.setObjectName("HintLabel")
        lay.addWidget(self._count_label)

    def _pick_audio(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择音频", "",
            "音频文件 (*.mp3 *.wav *.flac *.m4a *.aac *.ogg *.opus)",
        )
        if paths:
            self._add_paths(paths)

    def _add_paths(self, paths: list):
        for p in paths:
            if p not in self._items:
                self._items.append(p)
        self._save_store()
        self.refresh()
        self.audio_changed.emit()

    def _preview_audio(self, item):
        path = item.data(Qt.UserRole)
        if path and os.path.isfile(path):
            QDesktopServices.openUrl(QUrl.fromLocalFile(path))

    def refresh(self):
        checked = self._checked_paths()
        self.list_widget.blockSignals(True)
        self.list_widget.clear()
        for p in self._items:
            item = QListWidgetItem(os.path.basename(p))
            item.setToolTip(p)
            item.setData(Qt.UserRole, p)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Checked if p in checked else Qt.Unchecked)
            self.list_widget.addItem(item)
        self.list_widget.blockSignals(False)
        self._update_count()

    def _checked_paths(self) -> list:
        return [
            self.list_widget.item(i).data(Qt.UserRole)
            for i in range(self.list_widget.count())
            if self.list_widget.item(i).checkState() == Qt.Checked
        ]

    def _on_item_changed(self, item: QListWidgetItem):
        """参考音频唯一选择（radio 行为）。"""
        if item.checkState() == Qt.Checked:
            self.list_widget.blockSignals(True)
            for i in range(self.list_widget.count()):
                other = self.list_widget.item(i)
                if other is not item and other.checkState() == Qt.Checked:
                    other.setCheckState(Qt.Unchecked)
            self.list_widget.blockSignals(False)
        self._update_count()
        self.audio_changed.emit()

    def _delete_selected(self):
        paths = set(self._checked_paths())
        self._items = [p for p in self._items if p not in paths]
        self._save_store()
        self.refresh()
        self.audio_changed.emit()

    def _update_count(self):
        n = len(self._checked_paths())
        self._count_label.setText(f"已选 {n} / 共 {self.list_widget.count()} 个")

    def selected_audio(self) -> Optional[str]:
        sel = self._checked_paths()
        return sel[0] if sel else None


class VoiceTextPanel(QFrame):
    """目标文本面板（声音克隆）：输入要让克隆语音说的文本，实时显示字数/预估秒数/预估灵石。"""

    text_changed = Signal()

    def __init__(self, settings: QSettings, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self.settings = settings
        self._build_ui()

    def _build_ui(self):
        from PySide6.QtWidgets import QPlainTextEdit

        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 10, 10, 10)
        lay.setSpacing(8)

        title = QLabel("📝 目标文本", self)
        title.setObjectName("PanelTitle")
        lay.addWidget(title)

        hint = QLabel("克隆语音会说出以下文本（计费按输出音频估算秒数）：", self)
        hint.setObjectName("HintLabel")
        hint.setWordWrap(True)
        lay.addWidget(hint)

        self.text_edit = QPlainTextEdit(self)
        self.text_edit.setObjectName("VoiceText")
        self.text_edit.setPlaceholderText("在此输入要让克隆语音说的内容…")
        self.text_edit.setPlainText(self.settings.value("voice_text", "", type=str))
        self.text_edit.textChanged.connect(self._on_text_changed)
        lay.addWidget(self.text_edit, 1)

        self.info_label = QLabel("0 字", self)
        self.info_label.setObjectName("HintLabel")
        lay.addWidget(self.info_label)
        self._refresh_info()

    def _on_text_changed(self):
        self.settings.setValue("voice_text", self.text_edit.toPlainText())
        self._refresh_info()
        self.text_changed.emit()

    def _refresh_info(self):
        text = self.text_edit.toPlainText().strip()
        n = len(text)
        if n == 0:
            self.info_label.setText("0 字")
            return
        secs = estimate_voice_seconds(text)
        cost = secs * 0.5
        self.info_label.setText(f"{n} 字 · 约 {secs} 秒 · 预估 {cost:.1f} 灵石")

    def prompt_text(self) -> str:
        return self.text_edit.toPlainText().strip()


# ==================== 提交进度悬浮窗 ====================


class SubmitProgressOverlay(QDialog):
    """提交时的非模态悬浮进度窗：显示提交进度（已提交/总数 + 当前操作 + 进度条）。

    提交完成后自动关闭（on_submit_finished 调 close()）。用户可手动关闭（不阻断提交线程）。
    """

    def __init__(self, total: int, parent=None):
        super().__init__(parent)
        self.setWindowTitle("提交中")
        self.setWindowFlags(
            Qt.Window
            | Qt.WindowTitleHint
            | Qt.WindowStaysOnTopHint
            | Qt.CustomizeWindowHint
        )
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
        self.detail_label.setText(
            "窗口将在 2 秒后自动关闭" if failed == 0 else "部分失败，详情见任务卡片"
        )
        # 2 秒后自动关闭（成功时）；失败时保持让用户看到结果
        if failed == 0:
            from PySide6.QtCore import QTimer

            QTimer.singleShot(2000, self.close)


# ==================== 主窗口 ====================


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("RBFLow 创意工坊")
        self.resize(1500, 850)
        self.setMinimumSize(1200, 700)

        self.settings = QSettings("LingFang", "RbflowVideo")
        self.store = TaskStore(DATA_DIR / "tasks.json")
        self._submit_worker: Optional[SubmitWorker] = None
        self._voice_worker: Optional[VoiceSubmitWorker] = None
        self._submit_overlay = None  # 视频批量提交悬浮窗（音频单任务不用）
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
        self.tray.setToolTip("RBFLow 创意工坊")
        self.tray.show()

        self._build_ui()
        self._apply_theme()
        self._restore_geometry()
        self._refresh_status()

        # 恢复运行中任务的进度监听
        self._resume_progress()

        # 定时刷新：每 5 秒 ① 触发到期的自动重试 ② 轮询非终态任务。
        # 「自动重试」或「自动刷新」任一勾选即启动（重试不依赖自动刷新）。
        self._refresh_timer = QTimer(self)
        self._refresh_timer.timeout.connect(self._auto_refresh_tick)
        self._refresh_timer.setInterval(5000)
        self._sync_refresh_timer()

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
        title = QLabel("🎨 RBFLow 创意工坊", topbar)
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
        self.tier_combo.currentTextChanged.connect(
            lambda v: self.settings.setValue("tier", v)
        )
        tlay.addWidget(QLabel("档位:", topbar))
        tlay.addWidget(self.tier_combo)
        root.addWidget(topbar)

        # 顶部工作流切换 Tab：视频（动作迁移） / 音频（声音克隆）
        self.workspace_tabs = QTabWidget()
        self.workspace_tabs.setObjectName("WorkspaceTabs")

        # --- 视频工作流（原有三栏） ---
        self.video_workspace = QWidget()
        vlay = QVBoxLayout(self.video_workspace)
        vlay.setContentsMargins(0, 0, 0, 0)
        vlay.setSpacing(0)
        self.video_splitter = QSplitter(Qt.Horizontal)
        self.image_panel = ImagePanel()
        self.video_panel = VideoPanel(self.settings)
        self.video_splitter.addWidget(self.image_panel)
        self.video_splitter.addWidget(self.video_panel)
        self.video_splitter.setStretchFactor(0, 3)
        self.video_splitter.setStretchFactor(1, 4)
        vlay.addWidget(self.video_splitter)
        self.workspace_tabs.addTab(self.video_workspace, "🎬 视频 · 动作迁移")

        # --- 音频工作流（参考音频 + 目标文本） ---
        self.audio_workspace = QWidget()
        alay = QVBoxLayout(self.audio_workspace)
        alay.setContentsMargins(0, 0, 0, 0)
        alay.setSpacing(0)
        self.audio_splitter = QSplitter(Qt.Horizontal)
        self.audio_panel = AudioRefPanel()
        self.voice_panel = VoiceTextPanel(self.settings)
        self.audio_splitter.addWidget(self.audio_panel)
        self.audio_splitter.addWidget(self.voice_panel)
        self.audio_splitter.setStretchFactor(0, 3)
        self.audio_splitter.setStretchFactor(1, 4)
        alay.addWidget(self.audio_splitter)
        self.workspace_tabs.addTab(self.audio_workspace, "🎙 音频 · 声音克隆")

        # 任务队列面板：两个工作流共享同一实例，随 Tab 切换挂载到当前工作流右栏
        self.queue_panel = QueuePanel(self.store, self.settings)

        self.workspace_tabs.currentChanged.connect(self._on_workspace_changed)
        root.addWidget(self.workspace_tabs, 1)

        # 提交栏（随工作流切换语义：视频=笛卡尔积生成；音频=声音克隆）
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
        # 后台线程完成时长探测 + 缩略图生成后：刷新视频列表图标 + 预估信息
        self.video_panel.durations_ready.connect(self._on_video_assets_ready)
        # 音频工作流：参考音频/目标文本变化时更新预估
        self.audio_panel.audio_changed.connect(self._update_info)
        self.voice_panel.text_changed.connect(self._update_info)
        self.queue_panel.retry_task.connect(self._on_retry_task)
        self.queue_panel.delete_task.connect(self._on_delete_task)
        self.queue_panel.saveas_task.connect(self._on_saveas_task)
        self.queue_panel.open_task.connect(self._on_open_task)
        self.queue_panel.reorder_requested.connect(self.store.reorder)
        self.queue_panel.manual_refresh.connect(self._do_manual_refresh)
        # 「自动刷新」/「自动重试」勾选变化时启停定时器
        self.queue_panel.chk_auto_refresh.toggled.connect(self._on_auto_refresh_toggled)
        self.queue_panel.chk_auto_retry.toggled.connect(self._on_auto_refresh_toggled)

        # 初始把队列面板挂到当前 Tab（默认视频）并同步提交按钮/预估
        self._attach_queue_to_workspace()
        self._update_info()
        self._update_submit_button()
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)

    # ---------- 工作流切换 ----------
    def _current_kind(self) -> str:
        """当前工作流类型：0=视频，1=音频。"""
        return "audio" if self.workspace_tabs.currentIndex() == 1 else "video"

    def _attach_queue_to_workspace(self):
        """把共享的任务队列面板挂载到当前工作流的右栏。

        QSplitter 没有 removeWidget；用 setParent(None) 先脱离旧分割器（不删除控件），
        再 addWidget 到新分割器。addWidget 会自动把控件 reparent 到目标分割器。
        """
        self.queue_panel.setParent(None)
        if self._current_kind() == "audio":
            self.audio_splitter.addWidget(self.queue_panel)
            self.audio_splitter.setStretchFactor(2, 4)
        else:
            self.video_splitter.addWidget(self.queue_panel)
            self.video_splitter.setStretchFactor(2, 4)

    def _on_workspace_changed(self, _idx: int):
        self._attach_queue_to_workspace()
        self._update_submit_button()
        self._update_info()

    def _update_submit_button(self):
        if self._current_kind() == "audio":
            self.btn_submit.setText("🚀 生成克隆语音")
        else:
            self.btn_submit.setText("🚀 提交生成")

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

    def _on_auto_refresh_toggled(self, _enabled: bool):
        self._sync_refresh_timer()

    def _sync_refresh_timer(self):
        """「自动重试」或「自动刷新」任一勾选即启动定时器（两者共用 5s tick）。"""
        if self.queue_panel.auto_refresh() or self.queue_panel.auto_retry():
            if not self._refresh_timer.isActive():
                self._refresh_timer.start()
        else:
            self._refresh_timer.stop()

    def _do_manual_refresh(self):
        """手动刷新按钮：立即轮询所有非终态任务（同步，但每任务短超时）。"""
        self._poll_non_terminal_tasks()

    def _auto_refresh_tick(self):
        """定时器每 5 秒触发：① 触发到期的自动重试；② 轮询所有非终态任务。

        自动重试由「自动重试」勾选独立控制（不依赖「自动刷新」）；
        进度轮询由「自动刷新」控制。
        """
        self._process_due_retries()
        if self.queue_panel.auto_refresh():
            self._poll_non_terminal_tasks()

    def _poll_non_terminal_tasks(self):
        """对 PENDING/QUEUED/RUNNING/DOWNLOADING 任务调桥拉取最新进度。

        ProgressWorker 已是轮询模式；这里作为第二层兜底：覆盖刚启动尚未轮询到、
        或 worker 异常退出的任务。从 store 取最新状态避免与 worker 重复写终态。
        在独立线程执行，避免短超时阻塞 UI。
        """
        non_terminal = [
            t
            for t in self.store.all_ordered()
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
        # 停止所有 worker（视频提交 / 音频提交 / 进度监听）
        if self._submit_worker:
            self._submit_worker.stop()
            self._submit_worker.wait(3000)
        voice_worker = getattr(self, "_voice_worker", None)
        if voice_worker:
            voice_worker.stop()
            voice_worker.wait(3000)
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

    def _on_video_assets_ready(self):
        """后台线程完成时长探测 + 缩略图生成：刷新视频列表（加载已生成缩略图）
        + 用缓存时长更新预估。"""
        self.video_panel.refresh()
        self._update_info()

    def _update_info(self):
        """更新底部信息栏（随当前工作流切换语义）。"""
        if self._current_kind() == "audio":
            self._update_audio_info()
        else:
            self._update_video_info()

    def _update_video_info(self):
        """视频工作流预估。

        关键：只读 _DURATION_CACHE（cached_duration），绝不在此同步 spawn ffprobe
        —— 该槽由 itemChanged 触发（每次勾选都跑），若 spawn 子进程会让勾选卡
        数秒。时长由后台线程在「添加视频」时探测入缓存；未就绪时显示「时长计算中」。
        """
        imgs = self.image_panel.selected_items()
        vids = self.video_panel.selected_videos()
        n = len(imgs) * len(vids)
        durations = [cached_duration(v) for v in vids]
        if n == 0:
            self.info_label.setText(f"选 {len(imgs)} 图 × {len(vids)} 视频 = {n} 任务")
        elif vids and all(d is not None for d in durations):
            # 每个视频配全部图片：总时长 = 图片数 × 各视频时长之和
            total_sec = len(imgs) * sum(durations)
            cost = total_sec * 0.5
            self.info_label.setText(
                f"选 {len(imgs)} 图 × {len(vids)} 视频 = {n} 任务 · 预计 {total_sec:.0f}秒 · 约 {cost:.1f} 灵石"
            )
        else:
            self.info_label.setText(
                f"选 {len(imgs)} 图 × {len(vids)} 视频 = {n} 任务 · 时长计算中…"
            )

    def _update_audio_info(self):
        """音频工作流预估：由目标文本长度估算输出秒数（与 relay 计费公式一致）。"""
        audio = self.audio_panel.selected_audio()
        text = self.voice_panel.prompt_text()
        if not audio or not text:
            self.info_label.setText("选 1 个参考音频 + 输入目标文本 = 1 任务")
            return
        secs = estimate_voice_seconds(text)
        cost = secs * 0.5
        self.info_label.setText(
            f"1 个声音克隆任务 · 约 {secs} 秒 · 预估 {cost:.1f} 灵石"
        )

    # ---------- 提交 ----------
    def _on_submit(self):
        if self._current_kind() == "audio":
            self._on_submit_audio()
        else:
            self._on_submit_video()

    def _on_submit_video(self):
        if not bridge_ready():
            QMessageBox.warning(self, "未连接", "请在灵坊桌面端内运行本插件。")
            return
        imgs = self.image_panel.selected_items()
        vids = self.video_panel.selected_videos()
        if not imgs or not vids:
            QMessageBox.information(
                self, "未选择素材", "请至少选择 1 张图片和 1 个参考视频。"
            )
            return

        pairs = [
            (img_path, vid, img_cat) for (img_path, img_cat) in imgs for vid in vids
        ]
        n = len(pairs)
        # 预估总时长/灵石；探测失败时仍允许提交（SubmitWorker 会逐个探测并失败提示）。
        try:
            total_sec = sum(probe_duration_seconds(v) for _, v, _ in pairs)
            cost = total_sec * 0.5
            preview = f"将生成 {n} 个任务（共 {total_sec:.0f} 秒），预计消耗约 {cost:.1f} 灵石。"
        except Exception as e:
            preview = f"将生成 {n} 个任务。⚠ 无法预估时长（{e}），实际计费以各视频实际秒数为准。"
        if (
            QMessageBox.question(self, "确认提交", preview + "\n继续？")
            != QMessageBox.Yes
        ):
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

    def _on_submit_audio(self):
        if not bridge_ready():
            QMessageBox.warning(self, "未连接", "请在灵坊桌面端内运行本插件。")
            return
        audio = self.audio_panel.selected_audio()
        text = self.voice_panel.prompt_text()
        if not audio:
            QMessageBox.information(self, "未选择音频", "请选择 1 个参考音频。")
            return
        if not text:
            QMessageBox.information(self, "未输入文本", "请输入要让克隆语音说的目标文本。")
            return
        if len(text) > VOICE_MAX_PROMPT_CHARS:
            QMessageBox.warning(
                self, "文本过长",
                f"目标文本最多 {VOICE_MAX_PROMPT_CHARS} 字符（当前 {len(text)}），请精简后重试。",
            )
            return

        secs = estimate_voice_seconds(text)
        cost = secs * 0.5
        preview = (
            f"将生成 1 个声音克隆任务（约 {secs} 秒），预估消耗约 {cost:.1f} 灵石。\n"
            f"实际计费以平台按输出音频估算秒数为准。"
        )
        if QMessageBox.question(self, "确认提交", preview + "\n继续？") != QMessageBox.Yes:
            return

        tier = self.tier_combo.currentText()
        self.btn_submit.setEnabled(False)
        self.btn_submit.setText("提交中...")
        # 声音克隆为单任务，不走批量提交悬浮窗
        self._voice_worker = VoiceSubmitWorker(audio, text, tier, self)
        self._voice_worker.pair_submitted.connect(self._on_pair_submitted)
        self._voice_worker.pair_failed.connect(self._on_pair_failed)
        self._voice_worker.billing_blocked.connect(self._on_billing_blocked)
        self._voice_worker.finished_all.connect(self._on_submit_finished)
        self._voice_worker.start()

    def _on_pair_submitted(self, task: Task):
        self._apply_submit_result(task)
        # 更新提交悬浮窗进度（仅视频批量提交有）
        overlay = getattr(self, "_submit_overlay", None)
        if overlay is not None and overlay.isVisible():
            overlay.step_done()

    def _apply_submit_result(self, result: Task):
        """把 worker 的提交结果写回任务。

        原任务就地重试（store 已有该 pair_id）：更新字段并把状态改回 PENDING，
        不新建任务（保留队列位置与 retry_count）。新任务则 add。
        """
        existing = self.store.tasks.get(result.pair_id)
        if existing is not None:
            existing.rbflow_task_id = result.rbflow_task_id
            existing.call_log_id = result.call_log_id
            existing.charged_credits = result.charged_credits
            if result.seconds:
                existing.seconds = result.seconds
            existing.state = STATE_PENDING
            existing.progress = 0.0
            existing.error_msg = ""
            existing.next_retry_at = ""
            existing.finished_at = ""
            self.store.update(existing)
            self.queue_panel.refresh()
            self._start_progress(existing)
        else:
            self.store.add(result)
            self.queue_panel.refresh()
            self._start_progress(result)

    def _on_pair_failed(self, pair_id: str, err: str, task, retryable: bool = True):
        will_retry = False
        if task:
            task.state = STATE_FAILED
            task.error_msg = err
            existing = self.store.tasks.get(task.pair_id)
            if existing is not None:
                # 就地重试的提交阶段失败：更新原任务（保留 retry_count）
                existing.state = STATE_FAILED
                existing.error_msg = err
                self.store.update(existing)
                will_retry = self._schedule_retry(existing, retryable)
            else:
                self.store.add(task)
                will_retry = self._schedule_retry(task, retryable)
        self.queue_panel.refresh()
        logging.error(f"任务失败 {pair_id}: {err}")
        # 首个失败弹窗提示（避免每个失败都弹，批量时太吵）；若会自动重试则不弹（仅最终失败提示）。
        if will_retry:
            return
        if not getattr(self, "_first_fail_shown", False):
            self._first_fail_shown = True
            QMessageBox.warning(
                self,
                "任务失败",
                f"生成失败：{err}\n\n详情见任务卡片，完整错误已写入 data/app.log",
            )

    def _on_billing_blocked(self, msg: str):
        QMessageBox.warning(self, "余额不足", msg)

    def _on_submit_finished(self, submitted: int, failed: int):
        self.btn_submit.setEnabled(True)
        self._update_submit_button()  # 恢复当前工作流的按钮文案
        self._first_fail_shown = False  # 重置，下次提交再允许首失败弹窗
        # 关闭/完成提交悬浮窗（仅视频批量提交有；音频单任务无悬浮窗）
        overlay = getattr(self, "_submit_overlay", None)
        if overlay is not None and overlay.isVisible():
            overlay.finish(submitted, failed)
        if failed > 0:
            # 有失败：状态栏持久红色提示（不自动消失）
            self.status_bar.setStyleSheet("color: #f38ba8;")
            self.status_bar.showMessage(
                f"⚠ 提交完成：成功 {submitted}，失败 {failed}（见任务卡片 / data/app.log）",
                0,
            )
        else:
            self.status_bar.setStyleSheet("")
            self.status_bar.showMessage(
                f"✓ 提交完成：{submitted} 个任务已加入队列", 5000
            )

    # ---------- 进度 ----------
    def _start_progress(self, task: Task):
        if not task.rbflow_task_id:
            return
        if task.pair_id in self._progress_workers:
            return
        w = ProgressWorker(task.pair_id, task.rbflow_task_id, task.kind, self)
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
            if task.kind == "audio":
                name = Path(task.audio_path).stem
                title, body = "声音克隆完成", f"{name} 已生成，正在保存到本地"
            else:
                name = f"{Path(task.image_path).stem}_{Path(task.video_path).stem}"
                title, body = "视频生成完成", f"{name} 已生成，正在保存到本地"
            self.tray.showMessage(
                title,
                body,
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
        # 安排自动重试（达上限则保持失败=取消）；返回是否还会重试
        will_retry = self._schedule_retry(task, retryable=True)
        self.queue_panel.update_task_card(task)
        # 进度阶段失败弹窗：若会自动重试则不弹（避免每次重试都弹），仅最终失败提示
        if will_retry:
            return
        if task.kind == "audio":
            task_name = os.path.basename(task.audio_path or "音频")
        else:
            task_name = f"{os.path.basename(task.image_path)} × {os.path.basename(task.video_path)}"
        tried = f"（已自动重试 {task.retry_count} 次）" if task.retry_count else ""
        QMessageBox.warning(
            self,
            "生成失败",
            f"{task_name}{tried}\n失败原因：{reason}",
        )

    def _download_and_save(self, task: Task):
        """从桥下载成品（视频/音频）并落盘到自定义文件夹。"""
        if not task.rbflow_task_id:
            return
        is_audio = task.kind == "audio"
        try:
            result = bridge_download_video(task.rbflow_task_id, kind=task.kind)
            data_b64 = result.get("data", "")
            filename = result.get("filename") or f"{self._output_stem(task)}.{'flac' if is_audio else 'mp4'}"
            file_bytes = base64.b64decode(data_b64)

            # 命名模板：
            #   视频：{输出目录}\{日期}\{图片分类}\{图片名}_{视频名}.mp4
            #   音频：{输出目录}\{日期}\voice\{音频名}.flac
            out_root = Path(self.queue_panel.output_dir())
            date_str = (
                datetime.now().strftime("%Y-%-m-%-d")
                if sys.platform != "win32"
                else datetime.now().strftime("%Y-%#m-%#d")
            )
            sub = "voice" if is_audio else task.image_category
            dest_dir = out_root / date_str / sub
            dest_dir.mkdir(parents=True, exist_ok=True)
            stem = self._output_stem(task)
            # 从下载文件名推断扩展名（音频多为 .flac，视频 .mp4）
            ext = Path(filename).suffix or (".flac" if is_audio else ".mp4")
            # 同名文件不覆盖：已存在则自动追加 _1/_2/... 后缀
            dest = _unique_dest_path(dest_dir, stem, ext)
            dest.write_bytes(file_bytes)

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
            media = "音频" if is_audio else "视频"
            QMessageBox.warning(
                self,
                "下载失败",
                f"{media}已生成但保存失败：{e}\n\n可在任务卡片点「💾 另存为」重试。",
            )

    def _output_stem(self, task: Task) -> str:
        """输出文件名主干（不含扩展名）。音频用音频名；视频用 图片名_视频名。"""
        if task.kind == "audio":
            return Path(task.audio_path).stem or "voice"
        return f"{Path(task.image_path).stem}_{Path(task.video_path).stem}"

    # ---------- 卡片操作 ----------
    def _on_retry_task(self, pair_id: str):
        """手动重试（卡片 ↻ 按钮）：重置重试计数，立即就地重新提交。"""
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        task.retry_count = 0
        task.next_retry_at = ""
        task.error_msg = ""
        self.store.update(task)
        self._resubmit_task(task)

    def _resubmit_task(self, task: Task):
        """就地重新提交一个任务（复用 pair_id，提交结果经 _apply_submit_result 写回原任务）。"""
        tier = task.tier
        if task.kind == "audio":
            worker = VoiceSubmitWorker(task.audio_path, task.prompt_text, tier, task.pair_id, self)
        else:
            pairs = [(task.image_path, task.video_path, task.image_category)]
            worker = SubmitWorker(pairs, tier, task.pair_id, self)
        worker.pair_submitted.connect(self._apply_submit_result)
        worker.pair_failed.connect(self._on_pair_failed)
        # 持有引用避免 GC（与 _submit_worker/_voice_worker 同机制）
        self._retry_workers = getattr(self, "_retry_workers", [])
        self._retry_workers.append(worker)
        worker.finished.connect(lambda w=worker: self._retry_workers.remove(w) if w in self._retry_workers else None)
        worker.start()

    def _schedule_retry(self, task: Task, retryable: bool) -> bool:
        """失败后按「自动重试」配置安排下次重试。返回是否还会重试（False=已取消/最终失败）。

        规则：勾选自动重试 + retryable + retry_count < 上限 → 记录 next_retry_at，
        由 _process_due_retries 定时触发；否则保持 FAILED（取消）。
        余额不足等不可重试错误（retryable=False）永不自动重试。
        """
        if not (retryable and self.queue_panel.auto_retry()):
            return False
        max_retry = self.queue_panel.max_retry()
        if task.retry_count >= max_retry:
            task.next_retry_at = ""
            self.store.update(task)
            return False
        task.retry_count += 1
        interval = max(5, self.queue_panel.retry_interval())
        task.next_retry_at = datetime.fromtimestamp(
            time.time() + interval
        ).isoformat(timespec="seconds")
        task.error_msg = f"{task.error_msg}（第 {task.retry_count}/{max_retry} 次重试待触发）"
        self.store.update(task)
        return True

    def _process_due_retries(self):
        """定时器驱动：把到达 next_retry_at 的失败任务就地重新提交。"""
        if not self.queue_panel.auto_retry():
            return
        now = datetime.now()
        due = []
        for t in self.store.all_ordered():
            if t.state != STATE_FAILED or not t.next_retry_at:
                continue
            try:
                when = datetime.fromisoformat(t.next_retry_at)
            except ValueError:
                t.next_retry_at = ""
                self.store.update(t)
                continue
            if now >= when:
                due.append(t)
        for t in due:
            t.next_retry_at = ""  # 先清除，防重复触发
            t.state = STATE_PENDING
            t.error_msg = f"自动重试中（第 {t.retry_count} 次）"
            self.store.update(t)
            self._resubmit_task(t)
        if due:
            self.queue_panel.refresh()

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
            QMessageBox.warning(self, "无文件", "该任务暂无可保存的文件。")
            return
        file_filter = (
            "音频 (*.flac *.mp3 *.wav *.m4a *.aac *.ogg *.opus)"
            if task.kind == "audio"
            else "视频 (*.mp4)"
        )
        dest, _ = QFileDialog.getSaveFileName(
            self, "另存为", os.path.basename(src), file_filter
        )
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
            QMessageBox.information(
                self, "暂无文件", "该任务还未生成完成，请等待。"
            )


# ==================== 入口 ====================


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("RBFLow 创意工坊")
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
