# -*- coding: utf-8 -*-
# =============================================================================
# 视频下载器插件入口（runtime_type: python）
# -----------------------------------------------------------------------------
# 基于 videofetch（GitHub: CharlesPikachu/videodl）+ PySide6 (Qt6) 的桌面 GUI。
# 由桌面壳 start_plugin 命令在 %LOCALAPPDATA%/LingFang/python-venvs 下创建 venv
# （首次会从清华镜像 pip install videofetch + PySide6，约 100MB+，几十秒；之后幂等跳过）
# 后 detached 运行 `python -u main.py`。
#
# 界面在进程自己弹出的独立窗口（平台对 python/nodejs 插件只做启动器 + 进程监视），
# stdin/stdout 不参与交互，故全部交互走 Qt 事件循环。
#
# v0.2.0 增强：
#   - 首次启动欢迎对话框（图文教程），可跳过，data/settings.json 记忆「已引导」。
#   - 主界面内嵌「使用帮助」按钮，随时回看教程。
#   - 记忆最近一次下载目录与链接，下次启动自动回填。
#   - 美化 QSS：主按钮 hover 态、列表圆角与悬停、日志彩色（用 QTextBrowser 支持富文本）。
#
# videofetch 核心调用：
#     from videodl import videodl
#     client = videodl.VideoClient()
#     video_infos = client.parsefromurl(url)   # -> list[VideoInfo]
#     client.download(video_infos)             # 下载到各 VideoInfo.save_path
#
# 依赖：videofetch（PyPI 包名，import 名为 videodl）、PySide6（见 requirements.txt）。
# 部分平台（B站/腾讯/爱奇艺等 HLS 源）需系统 PATH 上有 FFmpeg（建议另装 N_m3u8DL-RE），
# 直接 mp4 源不受影响。启动时探测并提示，缺失不阻断 GUI。
#
# License: PolyForm-Noncommercial-1.0.0（仅学习用途，请遵守各平台版权与会员规则）。
# =============================================================================

import html
import json
import os
import shutil
import sys
import traceback
from pathlib import Path

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

# 同目录模块：从分享文案里抠出干净 URL，再交给 videofetch 解析。
# 用户从 App 分享面板复制的文字常含 emoji/中文/标点，直接丢给 videofetch 会
# 干扰 host 判定甚至触发上游 NoneType 崩溃；先提取纯 URL 大幅提升稳健性。
from url_extractor import extract_first_url

# 默认下载目录：插件相对路径 data/downloads（框架 ensure_plugin_dir 已创建 data/）。
# cwd = 插件目录，故相对路径 data/downloads 落在插件持久化目录下。
DEFAULT_DOWNLOAD_DIR = os.path.join("data", "downloads")

# 设置文件：data/settings.json（cwd=插件目录，data/ 由框架保证存在）。
SETTINGS_PATH = os.path.join("data", "settings.json")


def load_settings() -> dict:
    """读取 data/settings.json；不存在或损坏时返回空 dict（绝不阻断启动）。"""
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    """写入 data/settings.json；失败仅忽略（设置记忆是锦上添花，非关键路径）。"""
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


# 现代深色配色（与 calculator 插件同款视觉风格），v0.2.0 增强 hover/状态色。
_QSS = """
QMainWindow, QDialog { background: #1f2026; }
QLabel { color: #e8eaed; }
QLabel#section_label, QLabel#log_label, QLabel#guide_section {
    color: #bdc1c6; font-size: 13px; font-weight: 600;
}
QLabel#title_label { color: #ffffff; font-size: 22px; font-weight: 700; }
QLabel#subtitle_label { color: #9aa0a6; font-size: 13px; }
QLabel#step_label { color: #e8eaed; font-size: 14px; font-weight: 600; }
QLineEdit {
    color: #e8eaed; background: #2c2e36; border: 1px solid #3c3f4a;
    border-radius: 8px; padding: 8px; font-size: 14px;
}
QLineEdit:focus { border: 1px solid #4285f4; background: #303239; }
QListWidget {
    color: #e8eaed; background: #2c2e36; border: 1px solid #3c3f4a;
    border-radius: 8px; font-size: 13px; padding: 4px;
}
QListWidget::item { padding: 8px 10px; border-radius: 6px; }
QListWidget::item:hover { background: #34373f; }
QListWidget::item:selected { background: #4285f4; color: #ffffff; }
QTextBrowser {
    color: #9aa0a6; background: #2c2e36; border: 1px solid #3c3f4a;
    border-radius: 8px; font-size: 12px; font-family: 'Consolas','Microsoft YaHei',monospace;
}
QPushButton {
    color: #e8eaed; background: #2c2e36; border: 1px solid #3c3f4a;
    border-radius: 8px; padding: 8px 16px; font-size: 13px;
}
QPushButton:hover { background: #34373f; border: 1px solid #4a4e58; }
QPushButton:pressed { background: #3c3f4a; }
QPushButton:disabled { color: #5f6368; background: #2c2e36; border: 1px solid #2f3138; }
QPushButton#primary {
    background: #4285f4; color: #ffffff; border: 1px solid #4285f4; font-weight: 600;
}
QPushButton#primary:hover { background: #5a95f6; border: 1px solid #5a95f6; }
QPushButton#primary:pressed { background: #3367d6; }
QPushButton#primary:disabled { background: #3c3f4a; color: #5f6368; border: 1px solid #3c3f4a; }
QPushButton#help { background: transparent; color: #8ab4f8; border: 1px solid #3c3f4a; }
QPushButton#help:hover { background: #2c2e36; color: #aecbfa; }
"""


def has_ffmpeg() -> bool:
    """探测系统 PATH 上是否有 ffmpeg（videofetch 对 HLS 源会调它）。

    start_plugin 的 minimal_env 转发了宿主 PATH（含内置 ffmpeg 运行时），故系统/内置
    的 ffmpeg 可被发现。缺失仅影响 HLS 源（B站/腾讯/爱奇艺等），直接 mp4 源不受影响。
    """
    return shutil.which("ffmpeg") is not None


def resolve_download_dir(chosen: str) -> str:
    """把用户选的下载目录归一为存在的绝对路径；空则用默认 data/downloads。

    cwd = 插件目录，故 data/downloads 落在插件持久化目录下的 data 子目录。
    """
    target = chosen.strip() if chosen else DEFAULT_DOWNLOAD_DIR
    os.makedirs(target, exist_ok=True)
    return target


# === videofetch 上游补丁 ======================================================

# 补丁是否已打（幂等，进程内只打一次）。
_videodl_patched = False


def import_videodl():
    """import videofetch（import 名为 videodl）并打上游补丁，返回 videodl 模块。

    延迟 import：首次才触发 videofetch 较重的模块初始化，且便于 import 失败时给出
    友好提示而非启动即崩。

    上游 bug（videodl.modules.grabber.WebMediaGrabber.isprobablydirectmedia）：
    BaseVideoClient.get 在 max_retries 次重试全部失败时返回 None（而非抛异常），原方法
    直接在 None 上调 .raise_for_status()，抛 AttributeError——它不是 requests.
    RequestException，未被该方法的 except 捕获，从而让 VideoClient.parsefromurl 整体
    崩溃。表现：解析任意「探测失败」的链接（如小红书短链 xhslink.com）时直接
    AttributeError 退出，连后续的平台专用客户端（RednoteVideoClient）都没机会跑。

    修复：在外层兜底，把逃逸的 AttributeError 视作「不是直链」返回 (False, None)，
    让解析流程继续走平台专用 / 通用解析器，而非整体崩溃。补丁幂等，只打一次。
    """
    global _videodl_patched
    from videodl import videodl
    if not _videodl_patched:
        # WebMediaGrabber 已在 videodl/videodl.py 顶层 re-export，直接取用，
        # 保证与 VideoClient.web_media_grabber 是同一个类对象。
        grabber_cls = getattr(videodl, "WebMediaGrabber", None)
        if grabber_cls is not None:
            _orig_isprobablydirectmedia = grabber_cls.isprobablydirectmedia

            def _safe_isprobablydirectmedia(self, url, request_overrides=None):
                try:
                    return _orig_isprobablydirectmedia(self, url, request_overrides)
                except AttributeError:
                    # self.get() 重试耗尽返回 None 时，原方法在 None 上调
                    # raise_for_status 抛 AttributeError；兜底为「非直链」让解析继续。
                    return (False, None)

            grabber_cls.isprobablydirectmedia = _safe_isprobablydirectmedia
        _videodl_patched = True
    return videodl


# === 后台线程：解析与下载（避免阻塞 Qt 事件循环）===============================


class ParseWorker(QThread):
    """后台解析视频 URL。

    解析可能耗时数秒~数十秒（多次网络请求 + 平台探测），放 QThread 防止 UI 卡死。
    通过 pyqtSignal 把结果/异常回主线程，绝不在工作线程操作 UI 控件。
    """

    parsed = Signal(list)   # list[VideoInfo]，解析成功
    failed = Signal(str)    # 异常文本，解析失败

    def __init__(self, url: str):
        super().__init__()
        self._url = url

    def run(self):  # noqa: D401 - QThread 入口
        try:
            # import videofetch 并打上游补丁（见 import_videodl），补丁幂等只打一次。
            videodl = import_videodl()

            # videofetch 的 VideoClient.__init__ 有 bug：默认参数 allowed_video_sources=None，
            # 而 `set(None)` 会抛 TypeError。空列表会走 `if not allowed_video_sources` 分支
            # 自动展开为「全部支持的平台」，既绕过崩溃又保留「不指定=全部」的语义。
            client = videodl.VideoClient(allowed_video_sources=[])
            infos = client.parsefromurl(self._url)
            if not infos:
                self.failed.emit("未解析到任何视频（可能链接不支持或为付费内容）。")
                return
            self.parsed.emit(list(infos))
        except Exception as exc:  # noqa: BLE001 - 解析失败原因多样，统一兜底
            self.failed.emit(f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")


class DownloadWorker(QThread):
    """后台下载已选中的视频。

    client.download 会把视频落到每个 VideoInfo.save_path。为让下载落到用户选的目录，
    解析后先遍历 infos 重写 save_path 指向目标目录（保留原文件名）。
    """

    progress = Signal(str, str)     # (级别, 文本)，级别: info/success/error/warn
    finished_ok = Signal(int)       # 成功条数
    failed = Signal(str)            # 异常文本

    def __init__(self, infos: list, download_dir: str):
        super().__init__()
        self._infos = infos
        self._download_dir = download_dir

    def run(self):  # noqa: D401 - QThread 入口
        try:
            # import videofetch 并打上游补丁（见 import_videodl），补丁幂等只打一次。
            videodl = import_videodl()

            # 同 ParseWorker：传 [] 绕过 videofetch 的 VideoClient.__init__ 的 set(None) 崩溃，
            # 并等价于「使用全部支持的平台」。
            client = videodl.VideoClient(allowed_video_sources=[])
            # 把 save_path 指向用户选的目录（保留 videofetch 推断的文件名）。
            for info in self._infos:
                original = getattr(info, "save_path", None) or ""
                filename = os.path.basename(original) if original else f"{getattr(info, 'title', 'video')}.mp4"
                try:
                    info.save_path = os.path.join(self._download_dir, filename)
                except Exception:  # noqa: BLE001 - save_path 可能是只读属性，忽略时由 videofetch 自决路径
                    pass

            ok = 0
            for info in self._infos:
                title = getattr(info, "title", "") or getattr(info, "source", "") or "未知视频"
                self.progress.emit("info", f"开始下载：{title}")
                try:
                    client.download([info])
                    ok += 1
                    self.progress.emit("success", f"已下载：{title}")
                except Exception as exc:  # noqa: BLE001 - 单条失败不中断其余
                    self.progress.emit("error", f"下载失败：{title}（{type(exc).__name__}: {exc}）")
            self.finished_ok.emit(ok)
        except Exception as exc:  # noqa: BLE001 - import/下载整体失败
            self.failed.emit(f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")


# === 日志彩色化 ===============================================================
# QTextBrowser 支持 HTML，按级别着色。文本先 html.escape 防 XSS/误解析。

_LOG_COLORS = {
    "info": "#9aa0a6",      # 中性灰
    "success": "#81c995",   # 绿
    "error": "#f28b82",     # 红
    "warn": "#fdd663",      # 黄
}


def colored_log_line(level: str, text: str) -> str:
    """把一行日志包成带颜色的 HTML <div>，文本做 html 转义。"""
    color = _LOG_COLORS.get(level, "#9aa0a6")
    return f'<div style="color:{color};white-space:pre-wrap;">{html.escape(text)}</div>'


# === 欢迎 / 帮助对话框（图文教程，首次启动 & 随时回看共用）====================


def build_guide_html() -> str:
    """生成图文教程 HTML（深色背景，与 _QSS 一致）。"""
    ffmpeg_ok = has_ffmpeg()
    ffmpeg_note = (
        '<span style="color:#81c995;">✓ 已检测到 FFmpeg，HLS 源可正常下载</span>'
        if ffmpeg_ok else
        '<span style="color:#fdd663;">⚠ 未检测到 FFmpeg：HLS 源（B站/腾讯/爱奇艺等）可能失败，'
        '直接 mp4 源（抖音/快手等）不受影响</span>'
    )
    return f"""
<div style="color:#e8eaed;font-family:'Microsoft YaHei',sans-serif;line-height:1.7;">
  <div style="color:#ffffff;font-size:20px;font-weight:700;margin-bottom:4px;">
    🎬 视频下载器 · 使用教程
  </div>
  <div style="color:#9aa0a6;font-size:13px;margin-bottom:16px;">
    支持 B站 / 抖音 / YouTube / 快手 / 小红书 / 微博 等 100+ 平台（仅学习用途）
  </div>

  <div style="background:#2c2e36;border:1px solid #3c3f4a;border-radius:8px;padding:12px;margin-bottom:10px;">
    <div style="color:#8ab4f8;font-weight:700;margin-bottom:4px;">第 1 步 · 粘贴链接</div>
    <div style="color:#bdc1c6;font-size:13px;">
      在顶部输入框粘贴视频链接。<b>也可以直接粘贴整段分享文案</b>（如「看看这个 https://... 哈哈」），
      系统会自动提取其中的网址。
    </div>
  </div>

  <div style="background:#2c2e36;border:1px solid #3c3f4a;border-radius:8px;padding:12px;margin-bottom:10px;">
    <div style="color:#8ab4f8;font-weight:700;margin-bottom:4px;">第 2 步 · 点「解析」</div>
    <div style="color:#bdc1c6;font-size:13px;">
      点击蓝色「解析」按钮，等待几秒~几十秒（取决于平台与网络）。解析成功后下方列表显示所有可下载的视频。
    </div>
  </div>

  <div style="background:#2c2e36;border:1px solid #3c3f4a;border-radius:8px;padding:12px;margin-bottom:10px;">
    <div style="color:#8ab4f8;font-weight:700;margin-bottom:4px;">第 3 步 · 选择并下载</div>
    <div style="color:#bdc1c6;font-size:13px;">
      在列表中勾选要下载的视频（默认全选，可取消），选择「下载到」目录，点「下载选中」。
      进度会在底部日志区实时显示。
    </div>
  </div>

  <div style="background:#2c2e36;border:1px solid #3c3f4a;border-radius:8px;padding:12px;margin-bottom:10px;">
    <div style="color:#fdd663;font-weight:700;margin-bottom:4px;">💡 小提示</div>
    <div style="color:#bdc1c6;font-size:13px;">
      • 解析失败？换个链接，或确认是否为付费/会员内容。<br/>
      • 下载目录可点「浏览…」切换，会自动记住下次使用。<br/>
      • 视频仅供个人学习，请遵守各平台版权与会员规则。
    </div>
  </div>

  <div style="background:#2c2e36;border:1px solid #3c3f4a;border-radius:8px;padding:12px;">
    <div style="color:#8ab4f8;font-weight:700;margin-bottom:4px;">🔧 依赖状态</div>
    <div style="color:#bdc1c6;font-size:13px;">{ffmpeg_note}</div>
  </div>
</div>
"""


class GuideDialog(QDialog):
    """欢迎 / 帮助对话框（图文教程）。首次启动和点「使用帮助」共用同一份内容。"""

    def __init__(self, parent=None, *, is_welcome: bool = False):
        super().__init__(parent)
        self.setWindowTitle("欢迎使用视频下载器" if is_welcome else "使用帮助")
        self.resize(560, 640)
        self._is_welcome = is_welcome

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(12)

        browser = QTextBrowser()
        browser.setOpenExternalLinks(True)
        browser.setHtml(build_guide_html())
        layout.addWidget(browser, 1)

        button_row = QHBoxLayout()
        button_row.addStretch(1)
        close_btn = QPushButton("开始使用" if is_welcome else "关闭")
        close_btn.setObjectName("primary")
        close_btn.clicked.connect(self.accept)
        button_row.addWidget(close_btn)
        layout.addLayout(button_row)


# === 主窗口 ===================================================================


class VideoDownloaderWindow(QMainWindow):
    """视频下载器主窗口。

    布局：[使用帮助] + URL 输入 + 解析 → 结果列表（可多选）+ 下载目录 + 下载 → 底部日志。
    """

    def __init__(self):
        super().__init__()
        self.setWindowTitle("视频下载器")
        self.resize(780, 660)
        self._infos: list = []          # 最近一次解析的全部 VideoInfo
        self._parse_worker: ParseWorker | None = None
        self._download_worker: DownloadWorker | None = None
        self._settings: dict = load_settings()

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(18, 18, 18, 18)
        root.setSpacing(10)

        # --- 顶栏：标题 + 使用帮助 ---
        top_row = QHBoxLayout()
        top_row.setSpacing(8)
        title = QLabel("视频下载器")
        title.setObjectName("title_label")
        top_row.addWidget(title)
        top_row.addStretch(1)
        self.help_btn = QPushButton("📖 使用帮助")
        self.help_btn.setObjectName("help")
        self.help_btn.clicked.connect(self._on_help)
        top_row.addWidget(self.help_btn)
        root.addLayout(top_row)

        # --- URL 输入 + 解析 ---
        url_row = QHBoxLayout()
        url_label = QLabel("视频链接：")
        url_label.setObjectName("section_label")
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText("粘贴链接或分享文案（自动提取其中的 URL）")
        self.url_input.returnPressed.connect(self._on_parse)
        self.parse_btn = QPushButton("解析")
        self.parse_btn.setObjectName("primary")
        self.parse_btn.clicked.connect(self._on_parse)
        url_row.addWidget(url_label)
        url_row.addWidget(self.url_input, 1)
        url_row.addWidget(self.parse_btn)
        root.addLayout(url_row)

        # --- 结果列表（可多选下载）---
        result_label = QLabel("解析结果（可多选）：")
        result_label.setObjectName("section_label")
        root.addWidget(result_label)
        self.result_list = QListWidget()
        self.result_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        # 空状态占位提示
        self._show_empty_hint()
        root.addWidget(self.result_list, 1)

        # --- 下载目录 + 下载 ---
        dir_row = QHBoxLayout()
        dir_label = QLabel("下载到：")
        dir_label.setObjectName("section_label")
        self.dir_input = QLineEdit(
            self._settings.get("last_download_dir") or DEFAULT_DOWNLOAD_DIR
        )
        self.dir_input.setPlaceholderText("留空则下载到插件 data/downloads")
        self.browse_btn = QPushButton("浏览…")
        self.browse_btn.clicked.connect(self._on_browse)
        dir_row.addWidget(dir_label)
        dir_row.addWidget(self.dir_input, 1)
        dir_row.addWidget(self.browse_btn)
        root.addLayout(dir_row)

        self.download_btn = QPushButton("⬇ 下载选中")
        self.download_btn.setObjectName("primary")
        self.download_btn.clicked.connect(self._on_download)
        root.addWidget(self.download_btn)

        # --- 日志 ---
        log_label = QLabel("日志：")
        log_label.setObjectName("log_label")
        root.addWidget(log_label)
        self.log_view = QTextBrowser()
        self.log_view.setOpenExternalLinks(False)
        root.addWidget(self.log_view, 1)

        # 回填最近一次链接
        last_url = self._settings.get("last_url")
        if last_url:
            self.url_input.setText(last_url)

        self._log_plain(f"视频下载器已启动。Python {sys.version.split()[0]}。")
        if not has_ffmpeg():
            self._log(
                "warn",
                "未在系统 PATH 找到 FFmpeg：HLS 源（B站/腾讯/爱奇艺等）可能下载失败，"
                "请安装 FFmpeg 并加入 PATH。直接 mp4 源不受影响。",
            )
        else:
            self._log("success", "已检测到 FFmpeg，HLS 源可正常下载。")

    def _show_empty_hint(self) -> None:
        """结果列表的空状态占位（解析前显示一行提示）。"""
        self.result_list.clear()
        item = QListWidgetItem("请在上方粘贴链接并点「解析」")
        item.setFlags(item.flags() & ~Qt.ItemIsSelectable & ~Qt.ItemIsEnabled)
        self.result_list.addItem(item)

    # --- 日志辅助 ---
    def _log(self, level: str, text: str) -> None:
        """追加一行带级别着色的日志（QTextBrowser HTML）。"""
        self.log_view.append(colored_log_line(level, text))

    def _log_plain(self, text: str) -> None:
        """追加一行中性日志（兼容旧调用）。"""
        self.log_view.append(colored_log_line("info", text))

    # --- 使用帮助 ---
    def _on_help(self) -> None:
        GuideDialog(self, is_welcome=False).exec()

    # --- 解析 ---
    def _on_parse(self):
        raw = self.url_input.text().strip()
        if not raw:
            QMessageBox.warning(self, "提示", "请先粘贴视频链接。")
            return
        # 记忆最近链接
        self._settings["last_url"] = raw
        save_settings(self._settings)
        # 从「脏文本」里抠出第一个干净 URL（处理分享面板文案：emoji/中文/标点 +
        # 短链）。若已是纯 URL 则原样返回，无副作用。
        url = extract_first_url(raw)
        if not url:
            QMessageBox.warning(self, "提示", "未在输入中识别到有效的 http(s) 链接。")
            return
        # 复用解析期间禁用按钮，防止并发触发多个 worker。
        self.parse_btn.setEnabled(False)
        self.parse_btn.setText("解析中…")
        self.download_btn.setEnabled(False)
        self.result_list.clear()
        self._infos = []
        # 若用户粘的是脏文本（抠出的 URL 与原文本不同），提示已提取，便于排查。
        if url != raw:
            self._log("info", f"已从输入文本提取链接：{url}")
        self._log("info", f"正在解析：{url}")

        self._parse_worker = ParseWorker(url)
        self._parse_worker.parsed.connect(self._on_parsed)
        self._parse_worker.failed.connect(self._on_parse_failed)
        self._parse_worker.start()

    def _on_parsed(self, infos: list):
        self._infos = infos
        for index, info in enumerate(infos):
            title = getattr(info, "title", "") or "(无标题)"
            source = getattr(info, "source", "") or "未知来源"
            item = QListWidgetItem(f"[{index + 1}] {title}  ·  {source}")
            item.setData(Qt.UserRole, index)
            self.result_list.addItem(item)
            item.setSelected(True)  # 默认全选，用户可取消不需要的
        self._log("success", f"解析完成，共 {len(infos)} 个视频。")
        self._reset_parse_button()
        self.download_btn.setEnabled(True)

    def _on_parse_failed(self, message: str):
        self._log("error", f"解析失败：{message}")
        self._reset_parse_button()
        self._show_empty_hint()

    def _reset_parse_button(self):
        self.parse_btn.setEnabled(True)
        self.parse_btn.setText("解析")

    # --- 下载目录选择 ---
    def _on_browse(self):
        chosen = QFileDialog.getExistingDirectory(self, "选择下载目录", self.dir_input.text() or "")
        if chosen:
            self.dir_input.setText(chosen)

    # --- 下载 ---
    def _on_download(self):
        if not self._infos:
            QMessageBox.information(self, "提示", "请先解析视频。")
            return
        selected_rows = {item.data(Qt.UserRole) for item in self.result_list.selectedItems()}
        if not selected_rows:
            QMessageBox.information(self, "提示", "请在列表中至少选中一个视频。")
            return
        chosen_infos = [self._infos[i] for i in sorted(selected_rows) if 0 <= i < len(self._infos)]
        if not chosen_infos:
            return

        try:
            download_dir = resolve_download_dir(self.dir_input.text())
        except OSError as exc:
            QMessageBox.critical(self, "错误", f"无法创建下载目录：{exc}")
            return

        # 记忆最近下载目录
        self._settings["last_download_dir"] = download_dir
        save_settings(self._settings)

        self._log("info", f"开始下载 {len(chosen_infos)} 个视频到：{download_dir}")
        self.download_btn.setEnabled(False)
        self.download_btn.setText("下载中…")
        self.parse_btn.setEnabled(False)

        self._download_worker = DownloadWorker(chosen_infos, download_dir)
        self._download_worker.progress.connect(self._log)
        self._download_worker.finished_ok.connect(self._on_download_finished)
        self._download_worker.failed.connect(self._on_download_failed)
        self._download_worker.start()

    def _on_download_finished(self, ok_count: int):
        self._log("success", f"下载结束：成功 {ok_count} 个。")
        self.download_btn.setEnabled(True)
        self.download_btn.setText("⬇ 下载选中")
        self.parse_btn.setEnabled(True)

    def _on_download_failed(self, message: str):
        self._log("error", f"下载出错：{message}")
        self.download_btn.setEnabled(True)
        self.download_btn.setText("⬇ 下载选中")
        self.parse_btn.setEnabled(True)


# === 入口 =====================================================================

def main() -> int:
    app = QApplication(sys.argv)
    app.setFont(QFont("Microsoft YaHei", 10))
    app.setStyleSheet(_QSS)
    window = VideoDownloaderWindow()
    window.show()

    # 首次启动弹欢迎对话框（data/settings.json 的 onboarded 标记控制）。
    settings = window._settings  # 复用窗口已加载的设置
    if not settings.get("onboarded"):
        dialog = GuideDialog(window, is_welcome=True)
        dialog.exec()
        settings["onboarded"] = True
        save_settings(settings)

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
