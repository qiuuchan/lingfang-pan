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
    QProgressBar, QTabWidget, QCheckBox, QGroupBox, QFormLayout, QMessageBox,
    QSizePolicy, QFrame, QMenu, QAbstractItemView, QSplitter, QStatusBar,
)
from PySide6.QtCore import (
    Qt, QThread, Signal, QSize, QTimer, QSettings, QMimeData, QPoint,
)
from PySide6.QtGui import (
    QPixmap, QImage, QAction, QIcon, QColor, QFont, QPainter,
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
def probe_duration_seconds(video_path: str) -> float:
    """用 ffprobe 探测视频时长（秒）。失败回退到 ffmpeg-python，再失败返回 10（保守默认）。"""
    # 优先 ffprobe（subprocess，最快）
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            dur = float(result.stdout.strip())
            if dur > 0:
                return dur
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        pass

    # 回退 ffmpeg-python
    try:
        import ffmpeg
        probe = ffmpeg.probe(video_path)
        dur = float(probe.get("format", {}).get("duration", 0))
        if dur > 0:
            return dur
    except Exception:
        pass

    # 最终兜底：保守 10 秒（避免 0 秒白嫖嫌疑 + 让任务能提交）
    logging.warning(f"无法探测视频时长，使用保守默认 10 秒: {video_path}")
    return 10.0


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
            seconds = probe_duration_seconds(vid_path)
            task = Task(
                pair_id=pair_id, image_path=img_path, video_path=vid_path,
                seconds=seconds, tier=self.tier, image_category=img_cat,
                created_at=datetime.now().isoformat(timespec="seconds"),
            )
            task.touch()
            try:
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
    """单个任务的 SSE 进度监听（经桥聚合）。"""
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
                events = bridge_stream_video(self.rbflow_task_id)
                for ev in events:
                    if self._stop:
                        break
                    etype = ev.get("type", "")
                    if etype == "progress":
                        prog = float(ev.get("progress", 0))
                        state = ev.get("state", STATE_RUNNING)
                        self.progress_update.emit(self.pair_id, prog, state)
                    elif etype == "done":
                        self.progress_update.emit(self.pair_id, 100.0, STATE_SUCCESS)
                        self.done.emit(self.pair_id, json.dumps(ev, ensure_ascii=False))
                        return
                    elif etype == "error":
                        reason = ev.get("reason") or ev.get("error_advice") or "生成失败"
                        self.error.emit(self.pair_id, reason)
                        return
                # events 跑完但无终态（可能还在跑）→ 退避后重试
                if self._stop:
                    break
                retries += 1
                if retries > max_retries:
                    # 超过重试上限，转轮询兜底：间隔拉长继续
                    self.msleep(8000)
                else:
                    self.msleep(2000 * retries)
            except Exception as e:
                logging.warning(f"ProgressWorker {self.pair_id} 异常: {e}")
                retries += 1
                if retries > max_retries:
                    self.msleep(8000)
                else:
                    self.msleep(2000 * retries)


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
        info = QVBoxLayout(self)
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
        right = QVBoxLayout(self)
        right.setSpacing(4)
        self.badge = StatusBadge(task.state, self)
        right.addWidget(self.badge, alignment=Qt.AlignRight)

        ops = QHBoxLayout(self)
        ops.setSpacing(2)
        self.btn_retry = QPushButton("↻", self)
        self.btn_retry.setObjectName("IconBtn")
        self.btn_retry.setFixedSize(28, 24)
        self.btn_retry.setToolTip("重新执行")
        self.btn_retry.clicked.connect(lambda: self.retry_clicked.emit(self.task.pair_id))
        self.btn_saveas = QPushButton("💾", self)
        self.btn_saveas.setObjectName("IconBtn")
        self.btn_saveas.setFixedSize(28, 24)
        self.btn_saveas.setToolTip("另存为")
        self.btn_saveas.clicked.connect(lambda: self.saveas_clicked.emit(self.task.pair_id))
        self.btn_del = QPushButton("✕", self)
        self.btn_del.setObjectName("IconBtn")
        self.btn_del.setFixedSize(28, 24)
        self.btn_del.setToolTip("删除")
        self.btn_del.clicked.connect(lambda: self.delete_clicked.emit(self.task.pair_id))
        ops.addWidget(self.btn_retry)
        ops.addWidget(self.btn_saveas)
        ops.addWidget(self.btn_del)
        right.addLayout(ops)
        lay.addLayout(right)

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
    """图片素材库：选图/选文件夹、分类、多选缩略图列表、全选/反选/删除/移动。"""
    images_changed = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self._items: list[dict] = []  # [{path, category}]
        self._categories = ["默认"]
        self._cur_category = "默认"
        self.image_dir = PLUGIN_DIR / "data" / "image"
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self._build_ui()

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

        # 缩略图列表（图标模式）
        self.list_widget = QListWidget(self)
        self.list_widget.setObjectName("ImageList")
        self.list_widget.setViewMode(QListWidget.IconMode)
        self.list_widget.setIconSize(QSize(90, 90))
        self.list_widget.setResizeMode(QListWidget.Adjust)
        self.list_widget.setMovement(QListWidget.Static)
        self.list_widget.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.list_widget.setSpacing(4)
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
        self.refresh()
        self.images_changed.emit()

    def refresh(self):
        self.list_widget.clear()
        cat_items = [it for it in self._items if it["category"] == self._cur_category]
        for it in cat_items:
            item = QListWidgetItem(os.path.basename(it["path"]))
            item.setToolTip(it["path"])
            item.setData(Qt.UserRole, it["path"])
            pix = self._make_thumb(it["path"])
            if pix:
                item.setIcon(QIcon(pix))
            self.list_widget.addItem(item)
        self._count_label.setText(f"{len(cat_items)} 张（共 {len(self._items)}）")

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

    def _selected_paths(self) -> list:
        return [it.data(Qt.UserRole) for it in self.list_widget.selectedItems()]

    def _select_all(self):
        self.list_widget.selectAll()

    def _select_none(self):
        self.list_widget.clearSelection()

    def _invert(self):
        for i in range(self.list_widget.count()):
            it = self.list_widget.item(i)
            it.setSelected(not it.isSelected())

    def _delete_selected(self):
        paths = set(self._selected_paths())
        self._items = [it for it in self._items if it["path"] not in paths]
        self.refresh()
        self.images_changed.emit()

    def _move_selected(self):
        paths = set(self._selected_paths())
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
            self.refresh()

    def selected_items(self) -> list:
        """返回选中图片的 [(path, category)]。"""
        sel = set(self._selected_paths())
        return [(it["path"], it["category"]) for it in self._items if it["path"] in sel]


# ==================== 中栏：参考视频面板 ====================

class VideoPanel(QFrame):
    """参考视频库 + 工作流节点配置。"""
    videos_changed = Signal()

    def __init__(self, settings: QSettings, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self.settings = settings
        self._items: list[dict] = []
        self._categories = ["默认"]
        self._cur_category = "默认"
        self._build_ui()
        self._load_node_config()

    def _build_ui(self):
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 10, 10, 10)
        lay.setSpacing(8)

        title = QLabel("🎬 参考视频", self)
        title.setObjectName("PanelTitle")
        lay.addWidget(title)

        cat_row = QHBoxLayout()
        cat_row.addWidget(QLabel("分类:", self))
        self.cat_combo = QComboBox(self)
        self.cat_combo.addItems(self._categories)
        self.cat_combo.currentTextChanged.connect(self._on_category_changed)
        cat_row.addWidget(self.cat_combo, 1)
        lay.addLayout(cat_row)

        btn_row = QHBoxLayout()
        btn_pick = QPushButton("上传视频", self)
        btn_pick.clicked.connect(self._pick_videos)
        btn_dir = QPushButton("选择文件夹", self)
        btn_dir.clicked.connect(self._pick_folder)
        btn_row.addWidget(btn_pick)
        btn_row.addWidget(btn_dir)
        lay.addLayout(btn_row)

        self.list_widget = QListWidget(self)
        self.list_widget.setObjectName("VideoList")
        self.list_widget.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.list_widget.setSpacing(2)
        lay.addWidget(self.list_widget, 1)

        # 节点配置组
        node_group = QGroupBox("⚙ 工作流节点配置", self)
        form = QFormLayout(node_group)
        self.img_node = QLineEdit("78", self)
        self.img_field = QLineEdit("image", self)
        self.vid_node = QLineEdit("77", self)
        self.vid_field = QLineEdit("video", self)
        form.addRow("图片节点 ID", self.img_node)
        form.addRow("图片字段名", self.img_field)
        form.addRow("视频节点 ID", self.vid_node)
        form.addRow("视频字段名", self.vid_field)
        for w in (self.img_node, self.img_field, self.vid_node, self.vid_field):
            w.editingFinished.connect(self._save_node_config)
        lay.addWidget(node_group)

        hint = QLabel("节点 ID 由工作流决定（默认 78/77），一般无需修改。", self)
        hint.setObjectName("HintLabel")
        hint.setWordWrap(True)
        lay.addWidget(hint)

        self._count_label = QLabel("0 个", self)
        self._count_label.setObjectName("HintLabel")
        lay.addWidget(self._count_label)

    def _on_category_changed(self, cat: str):
        self._cur_category = cat
        self.refresh()

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
        self.refresh()
        self.videos_changed.emit()

    def refresh(self):
        self.list_widget.clear()
        cat_items = [it for it in self._items if it["category"] == self._cur_category]
        for it in cat_items:
            item = QListWidgetItem(f"📹 {os.path.basename(it['path'])}")
            item.setToolTip(it["path"])
            item.setData(Qt.UserRole, it["path"])
            self.list_widget.addItem(item)
        self._count_label.setText(f"{len(cat_items)} 个（共 {len(self._items)}）")

    def _load_node_config(self):
        self.img_node.setText(self.settings.value("node/image_id", "78"))
        self.img_field.setText(self.settings.value("node/image_field", "image"))
        self.vid_node.setText(self.settings.value("node/video_id", "77"))
        self.vid_field.setText(self.settings.value("node/video_field", "video"))

    def _save_node_config(self):
        self.settings.setValue("node/image_id", self.img_node.text())
        self.settings.setValue("node/image_field", self.img_field.text())
        self.settings.setValue("node/video_id", self.vid_node.text())
        self.settings.setValue("node/video_field", self.vid_field.text())

    def selected_videos(self) -> list:
        sel = set(it.data(Qt.UserRole) for it in self.list_widget.selectedItems())
        return [it["path"] for it in self._items if it["path"] in sel]


# ==================== 右栏：任务队列面板 ====================

class QueuePanel(QFrame):
    """任务队列：统计、状态筛选 tab、自定义输出目录、任务卡片、批量操作。"""
    submit_requested = Signal(list, str)   # pairs, tier
    retry_task = Signal(str)               # pair_id
    delete_task = Signal(str)              # pair_id
    saveas_task = Signal(str)              # pair_id
    reorder_requested = Signal(list)       # pair_ids in new order

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
        self.list_widget.setSelectionMode(QAbstractItemView.SingleSelection)
        self.list_widget.setDragDropMode(QAbstractItemView.InternalMove)
        self.list_widget.setDefaultDropAction(Qt.MoveAction)
        self.list_widget.model().rowsMoved.connect(self._on_rows_moved)
        lay.addWidget(self.list_widget, 1)

        # 底部批量操作
        batch = QHBoxLayout()
        self.btn_clear_done = QPushButton("清除已完成", self)
        self.btn_clear_done.clicked.connect(self._clear_done)
        self.btn_del_all = QPushButton("清空全部", self)
        self.btn_del_all.setObjectName("DangerBtn")
        self.btn_del_all.clicked.connect(self._delete_all)
        self.chk_auto_retry = QCheckBox("自动重试", self)
        self.chk_auto_retry.setChecked(bool(self.settings.value("auto_retry", False, type=bool)))
        self.chk_auto_retry.toggled.connect(lambda v: self.settings.setValue("auto_retry", v))
        self.chk_auto_refresh = QCheckBox("自动刷新", self)
        self.chk_auto_refresh.setChecked(True)
        batch.addWidget(self.chk_auto_retry)
        batch.addWidget(self.chk_auto_refresh)
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


# ==================== 主窗口 ====================

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("动作迁移视频生成")
        self.resize(1280, 800)
        self.setMinimumSize(1000, 650)

        self.settings = QSettings("LingFang", "RbflowVideo")
        self.store = TaskStore(DATA_DIR / "tasks.json")
        self._submit_worker: Optional[SubmitWorker] = None
        self._progress_workers: dict[str, ProgressWorker] = {}

        self._build_ui()
        self._load_theme()
        self._restore_geometry()
        self._refresh_status()

        # 恢复运行中任务的进度监听
        self._resume_progress()

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
        self.queue_panel.retry_task.connect(self._on_retry_task)
        self.queue_panel.delete_task.connect(self._on_delete_task)
        self.queue_panel.saveas_task.connect(self._on_saveas_task)
        self.queue_panel.reorder_requested.connect(self.store.reorder)

        self._update_info()
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)

    def _load_theme(self):
        qss_path = PLUGIN_DIR / "theme.qss"
        if qss_path.exists():
            try:
                self.setStyleSheet(qss_path.read_text(encoding="utf-8"))
            except Exception as e:
                logging.error(f"加载主题失败: {e}")

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
        total_sec = 0.0
        for _, v in [(img, vid) for img in imgs for vid in vids]:
            total_sec += probe_duration_seconds(v)
        cost = total_sec * 0.5
        self.info_label.setText(
            f"选 {len(imgs)} 图 × {len(vids)} 视频 = {n} 任务 · 预计 {total_sec:.0f}秒 · 约 {cost:.1f} 灵石"
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
        total_sec = sum(probe_duration_seconds(v) for _, v, _ in pairs)
        cost = total_sec * 0.5
        if QMessageBox.question(
            self, "确认提交",
            f"将生成 {n} 个任务（{total_sec:.0f} 秒），预计消耗约 {cost:.1f} 灵石。\n继续？"
        ) != QMessageBox.Yes:
            return

        tier = self.tier_combo.currentText()
        self.btn_submit.setEnabled(False)
        self.btn_submit.setText("提交中...")
        self._submit_worker = SubmitWorker(pairs, tier, self)
        self._submit_worker.pair_submitted.connect(self._on_pair_submitted)
        self._submit_worker.pair_failed.connect(self._on_pair_failed)
        self._submit_worker.billing_blocked.connect(self._on_billing_blocked)
        self._submit_worker.finished_all.connect(self._on_submit_finished)
        self._submit_worker.start()

    def _on_pair_submitted(self, task: Task):
        self.store.add(task)
        self.queue_panel.refresh()
        # 启动该任务的进度监听
        self._start_progress(task)

    def _on_pair_failed(self, pair_id: str, err: str, task):
        if task:
            task.state = STATE_FAILED
            task.error_msg = err
            self.store.add(task)
        self.queue_panel.refresh()
        logging.error(f"任务失败 {pair_id}: {err}")

    def _on_billing_blocked(self, msg: str):
        QMessageBox.warning(self, "余额不足", msg)

    def _on_submit_finished(self, submitted: int, failed: int):
        self.btn_submit.setEnabled(True)
        self.btn_submit.setText("🚀 提交生成")
        self.status_bar.showMessage(f"提交完成：成功 {submitted}，失败 {failed}", 5000)

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
        # 下载落盘
        self._download_and_save(task)

    def _on_progress_error(self, pair_id: str, reason: str):
        task = self.store.tasks.get(pair_id)
        if not task:
            return
        task.state = STATE_FAILED
        task.error_msg = reason
        task.finished_at = datetime.now().isoformat(timespec="seconds")
        self.store.update(task)
        self.queue_panel.update_task_card(task)
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
            self.status_bar.showMessage(f"已保存：{dest}", 5000)
        except Exception as e:
            logging.error(f"下载落盘失败 {task.pair_id}: {e}")
            task.error_msg = f"下载失败: {e}"
            self.store.update(task)
            self.queue_panel.update_task_card(task)

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


# ==================== 入口 ====================

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("RBFLow 视频生成")
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
