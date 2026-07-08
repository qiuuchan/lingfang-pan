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

import os
import shutil
import sys
import traceback
from pathlib import Path

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

# 默认下载目录：插件相对路径 data/downloads（框架 ensure_plugin_dir 已创建 data/）。
# cwd = 插件目录，故相对路径 data/downloads 落在插件持久化目录下。
DEFAULT_DOWNLOAD_DIR = os.path.join("data", "downloads")

# 现代深色配色（与 calculator 插件同款视觉风格）。
_QSS = """
QMainWindow { background: #1f2026; }
QLabel { color: #e8eaed; }
QLineEdit {
    color: #e8eaed; background: #2c2e36; border: 1px solid #3c3f4a;
    border-radius: 8px; padding: 8px; font-size: 14px;
}
QLineEdit:focus { border: 1px solid #4285f4; }
QListWidget {
    color: #e8eaed; background: #2c2e36; border: 1px solid #3c3f4a;
    border-radius: 8px; font-size: 13px;
}
QListWidget::item { padding: 6px 8px; }
QListWidget::item:selected { background: #4285f4; color: #ffffff; }
QPlainTextEdit {
    color: #9aa0a6; background: #2c2e36; border: 1px solid #3c3f4a;
    border-radius: 8px; font-size: 12px;
}
QPushButton {
    color: #e8eaed; background: #2c2e36; border: none; border-radius: 8px;
    padding: 8px 16px; font-size: 13px;
}
QPushButton:pressed { background: #3c3f4a; }
QPushButton:disabled { color: #5f6368; background: #2c2e36; }
QPushButton#primary { background: #4285f4; color: #ffffff; }
QPushButton#primary:pressed { background: #3367d6; }
QPushButton#primary:disabled { background: #3c3f4a; color: #5f6368; }
"""


def has_ffmpeg() -> bool:
    """探测系统 PATH 上是否有 ffmpeg（videofetch 对 HLS 源会调它）。

    start_plugin 的 minimal_env 转发了宿主 PATH，故系统装的 ffmpeg 可被发现。
    缺失仅影响 HLS 源（B站/腾讯/爱奇艺等），直接 mp4 源不受影响。
    """
    return shutil.which("ffmpeg") is not None


def resolve_download_dir(chosen: str) -> str:
    """把用户选的下载目录归一为存在的绝对路径；空则用默认 data/downloads。

    cwd = 插件目录，故 data/downloads 落在插件持久化目录下的 data 子目录。
    """
    target = chosen.strip() if chosen else DEFAULT_DOWNLOAD_DIR
    os.makedirs(target, exist_ok=True)
    return target


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
            # 延迟 import：首次会触发 videofetch 较重的模块初始化，且便于在 import 失败时
            # 给出友好提示而非启动即崩。
            from videodl import videodl

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

    progress = Signal(str)      # 进度日志（逐条）
    finished_ok = Signal(int)   # 成功条数
    failed = Signal(str)        # 异常文本

    def __init__(self, infos: list, download_dir: str):
        super().__init__()
        self._infos = infos
        self._download_dir = download_dir

    def run(self):  # noqa: D401 - QThread 入口
        try:
            from videodl import videodl

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
                self.progress.emit(f"开始下载：{title}")
                try:
                    client.download([info])
                    ok += 1
                    self.progress.emit(f"✓ 已下载：{title}")
                except Exception as exc:  # noqa: BLE001 - 单条失败不中断其余
                    self.progress.emit(f"✗ 下载失败：{title}（{type(exc).__name__}: {exc}）")
            self.finished_ok.emit(ok)
        except Exception as exc:  # noqa: BLE001 - import/下载整体失败
            self.failed.emit(f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")


# === 主窗口 ===================================================================


class VideoDownloaderWindow(QMainWindow):
    """视频下载器主窗口。

    布局：URL 输入 + 解析 → 结果列表（可多选）+ 下载目录 + 下载 → 底部日志。
    """

    def __init__(self):
        super().__init__()
        self.setWindowTitle("视频下载器")
        self.resize(720, 600)
        self._infos: list = []          # 最近一次解析的全部 VideoInfo
        self._parse_worker: ParseWorker | None = None
        self._download_worker: DownloadWorker | None = None

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(10)

        # --- URL 输入 + 解析 ---
        url_row = QHBoxLayout()
        url_label = QLabel("视频链接：")
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText("粘贴 B站 / 抖音 / YouTube / 小红书 等视频链接")
        self.url_input.returnPressed.connect(self._on_parse)
        self.parse_btn = QPushButton("解析")
        self.parse_btn.setObjectName("primary")
        self.parse_btn.clicked.connect(self._on_parse)
        url_row.addWidget(url_label)
        url_row.addWidget(self.url_input, 1)
        url_row.addWidget(self.parse_btn)
        root.addLayout(url_row)

        # --- 结果列表（可多选下载）---
        root.addWidget(QLabel("解析结果（可多选）："))
        self.result_list = QListWidget()
        self.result_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        root.addWidget(self.result_list, 1)

        # --- 下载目录 + 下载 ---
        dir_row = QHBoxLayout()
        dir_row.addWidget(QLabel("下载到："))
        self.dir_input = QLineEdit(DEFAULT_DOWNLOAD_DIR)
        self.dir_input.setPlaceholderText("留空则下载到插件 data/downloads")
        self.browse_btn = QPushButton("浏览…")
        self.browse_btn.clicked.connect(self._on_browse)
        dir_row.addWidget(self.dir_input, 1)
        dir_row.addWidget(self.browse_btn)
        root.addLayout(dir_row)

        self.download_btn = QPushButton("下载选中")
        self.download_btn.setObjectName("primary")
        self.download_btn.clicked.connect(self._on_download)
        root.addWidget(self.download_btn)

        # --- 日志 ---
        root.addWidget(QLabel("日志："))
        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumBlockCount(2000)  # 限制行数防内存膨胀
        root.addWidget(self.log_view, 1)

        self._log(f"视频下载器已启动。Python {sys.version.split()[0]}。")
        if not has_ffmpeg():
            self._log(
                "⚠ 未在系统 PATH 找到 FFmpeg：HLS 源（B站/腾讯/爱奇艺等）可能下载失败，"
                "请安装 FFmpeg 并加入 PATH。直接 mp4 源不受影响。"
            )
        else:
            self._log("✓ 已检测到 FFmpeg，HLS 源可正常下载。")

    # --- 日志辅助 ---
    def _log(self, text: str):
        self.log_view.appendPlainText(text)

    # --- 解析 ---
    def _on_parse(self):
        url = self.url_input.text().strip()
        if not url:
            QMessageBox.warning(self, "提示", "请先粘贴视频链接。")
            return
        # 复用解析期间禁用按钮，防止并发触发多个 worker。
        self.parse_btn.setEnabled(False)
        self.parse_btn.setText("解析中…")
        self.download_btn.setEnabled(False)
        self.result_list.clear()
        self._infos = []
        self._log(f"正在解析：{url}")

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
        self._log(f"解析完成，共 {len(infos)} 个视频。")
        self._reset_parse_button()
        self.download_btn.setEnabled(True)

    def _on_parse_failed(self, message: str):
        self._log(f"✗ 解析失败：{message}")
        self._reset_parse_button()

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

        self._log(f"开始下载 {len(chosen_infos)} 个视频到：{download_dir}")
        self.download_btn.setEnabled(False)
        self.download_btn.setText("下载中…")
        self.parse_btn.setEnabled(False)

        self._download_worker = DownloadWorker(chosen_infos, download_dir)
        self._download_worker.progress.connect(self._log)
        self._download_worker.finished_ok.connect(self._on_download_finished)
        self._download_worker.failed.connect(self._on_download_failed)
        self._download_worker.start()

    def _on_download_finished(self, ok_count: int):
        self._log(f"下载结束：成功 {ok_count} 个。")
        self.download_btn.setEnabled(True)
        self.download_btn.setText("下载选中")
        self.parse_btn.setEnabled(True)

    def _on_download_failed(self, message: str):
        self._log(f"✗ 下载出错：{message}")
        self.download_btn.setEnabled(True)
        self.download_btn.setText("下载选中")
        self.parse_btn.setEnabled(True)


# === 入口 =====================================================================

def main() -> int:
    app = QApplication(sys.argv)
    app.setFont(QFont("Microsoft YaHei", 10))
    app.setStyleSheet(_QSS)
    window = VideoDownloaderWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
