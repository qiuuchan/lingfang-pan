"""AI 换装批量版 - 主窗口"""

import os

from PySide6.QtCore import Qt, QThread, QSize
from PySide6.QtGui import QIcon, QPixmap
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QLineEdit, QComboBox, QSpinBox,
    QGroupBox, QStackedWidget, QFileDialog, QMessageBox,
    QProgressBar, QListWidget, QListWidgetItem,
)

from widgets import DropZone, ImageListPanel
from worker import BatchWorker
from api import build_prompt

ALL_MODES = ["换装（全套）", "换内搭", "换头", "批量换装"]


class MainWindow(QMainWindow):
    """AI 换装批量版主窗口"""

    def __init__(self):
        super().__init__()
        self._worker: BatchWorker | None = None
        self._thread: QThread | None = None
        self._output_dir: str = ""
        self._setup_ui()
        self._connect_signals()
        self.setWindowTitle("AI 换装批量版")
        self.resize(960, 740)

    # ------------------------------------------------------------------
    # UI 构建
    # ------------------------------------------------------------------

    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        main_layout.setSpacing(8)

        self._build_mode_selector(main_layout)
        self._build_settings(main_layout)
        self._build_image_input(main_layout)
        self._build_action_bar(main_layout)
        self._build_progress(main_layout)
        self._build_results(main_layout)

    def _build_mode_selector(self, parent: QVBoxLayout):
        row = QHBoxLayout()
        self._mode_btns: dict[str, QPushButton] = {}
        for mode in ALL_MODES:
            btn = QPushButton(mode)
            btn.setCheckable(True)
            btn.setChecked(mode == "换装（全套）")
            self._mode_btns[mode] = btn
            row.addWidget(btn)
        parent.addLayout(row)

    def _build_settings(self, parent: QVBoxLayout):
        group = QGroupBox("API 设置")
        layout = QVBoxLayout(group)

        # Key 行
        key_row = QHBoxLayout()
        key_row.addWidget(QLabel("API Key:"))
        self._key_input = QLineEdit(
            "sk-sQXtwgZlIFnvR2dvpgnOz7vj1gYhyxqFV6picL8iJk2lFKOO"
        )
        self._key_input.setEchoMode(QLineEdit.Password)
        self._key_toggle = QPushButton("显示")
        self._key_toggle.setFixedWidth(50)
        key_row.addWidget(self._key_input)
        key_row.addWidget(self._key_toggle)
        layout.addLayout(key_row)

        # 选项行
        opts = QHBoxLayout()
        opts.addWidget(QLabel("API Group:"))
        self._group_combo = QComboBox()
        self._group_combo.addItems(["default", "A1", "A2", "A3"])
        opts.addWidget(self._group_combo)
        opts.addWidget(QLabel("并发数:"))
        self._concurrency_spin = QSpinBox()
        self._concurrency_spin.setRange(1, 8)
        self._concurrency_spin.setValue(4)
        opts.addWidget(self._concurrency_spin)
        opts.addWidget(QLabel("输出目录:"))
        self._dir_input = QLineEdit()
        self._dir_input.setPlaceholderText("默认：源图所在目录")
        self._dir_btn = QPushButton("选择")
        opts.addWidget(self._dir_input)
        opts.addWidget(self._dir_btn)
        opts.addStretch()
        layout.addLayout(opts)
        parent.addWidget(group)

    def _build_image_input(self, parent: QVBoxLayout):
        self._input_stack = QStackedWidget()

        # 页面 0：单人模式（两个 DropZone）
        page0 = QWidget()
        p0 = QHBoxLayout(page0)
        self._zone1 = DropZone("图1（人物/模特）\n点击选择或拖拽")
        self._zone2 = DropZone("图2（服装/内搭/头像）\n点击选择或拖拽")
        p0.addWidget(self._zone1)
        p0.addWidget(self._zone2)
        self._input_stack.addWidget(page0)

        # 页面 1：批量模式（两个 ImageListPanel）
        page1 = QWidget()
        p1 = QHBoxLayout(page1)
        self._clothes_panel = ImageListPanel("服装图区", 3)
        self._models_panel = ImageListPanel("模特姿态图区", 20)
        p1.addWidget(self._clothes_panel)
        p1.addWidget(self._models_panel)
        self._input_stack.addWidget(page1)

        parent.addWidget(self._input_stack)

    def _build_action_bar(self, parent: QVBoxLayout):
        row = QHBoxLayout()
        self._task_label = QLabel("任务数：0")
        row.addWidget(self._task_label)
        row.addStretch()

        self._start_btn = QPushButton("开始处理")
        self._start_btn.setStyleSheet(
            "QPushButton { background: #4a90d9; color: white; "
            "padding: 8px 28px; font-size: 14px; border-radius: 4px; }"
            "QPushButton:hover { background: #357abd; }"
            "QPushButton:disabled { background: #ccc; }"
        )
        self._cancel_btn = QPushButton("取消")
        self._cancel_btn.setEnabled(False)
        row.addWidget(self._start_btn)
        row.addWidget(self._cancel_btn)
        parent.addLayout(row)

    def _build_progress(self, parent: QVBoxLayout):
        self._progress_bar = QProgressBar()
        parent.addWidget(self._progress_bar)
        self._log_list = QListWidget()
        self._log_list.setMaximumHeight(100)
        parent.addWidget(self._log_list)

    def _build_results(self, parent: QVBoxLayout):
        group = QGroupBox("结果预览")
        layout = QVBoxLayout(group)

        self._result_area = QListWidget()
        self._result_area.setViewMode(QListWidget.IconMode)
        self._result_area.setIconSize(QSize(120, 120))
        self._result_area.setResizeMode(QListWidget.Adjust)
        layout.addWidget(self._result_area)

        btn_row = QHBoxLayout()
        btn_row.addStretch()
        self._open_dir_btn = QPushButton("打开输出目录")
        self._open_dir_btn.setEnabled(False)
        btn_row.addWidget(self._open_dir_btn)
        layout.addLayout(btn_row)
        parent.addWidget(group)

    # ------------------------------------------------------------------
    # 信号连接
    # ------------------------------------------------------------------

    def _connect_signals(self):
        for mode, btn in self._mode_btns.items():
            btn.clicked.connect(lambda checked, m=mode: self._on_mode_changed(m))
        self._key_toggle.clicked.connect(self._toggle_key)
        self._dir_btn.clicked.connect(self._select_dir)
        self._start_btn.clicked.connect(self._on_start)
        self._cancel_btn.clicked.connect(self._on_cancel)
        self._open_dir_btn.clicked.connect(self._open_output_dir)

    # ------------------------------------------------------------------
    # 事件处理
    # ------------------------------------------------------------------

    def _on_mode_changed(self, mode: str):
        for m, btn in self._mode_btns.items():
            btn.setChecked(m == mode)
        self._input_stack.setCurrentIndex(1 if mode == "批量换装" else 0)

    def _toggle_key(self):
        if self._key_input.echoMode() == QLineEdit.Password:
            self._key_input.setEchoMode(QLineEdit.Normal)
            self._key_toggle.setText("隐藏")
        else:
            self._key_input.setEchoMode(QLineEdit.Password)
            self._key_toggle.setText("显示")

    def _select_dir(self):
        path = QFileDialog.getExistingDirectory(self, "选择输出目录")
        if path:
            self._dir_input.setText(path)
            self._output_dir = path

    def _resolve_output_dir(self, mode: str) -> str:
        d = self._dir_input.text().strip() or self._output_dir
        if d:
            return d
        if mode == "批量换装":
            paths = self._clothes_panel.paths() or self._models_panel.paths()
        else:
            paths = [p for p in (self._zone1.path(), self._zone2.path()) if p]
        if paths:
            return os.path.dirname(paths[0])
        return os.getcwd()

    def _on_start(self):
        api_key = self._key_input.text().strip()
        api_group = self._group_combo.currentText()
        concurrency = self._concurrency_spin.value()
        current_mode = next(m for m, b in self._mode_btns.items() if b.isChecked())
        prompt = build_prompt(current_mode)
        output_dir = self._resolve_output_dir(current_mode)

        if current_mode == "批量换装":
            clothes = self._clothes_panel.paths()
            models = self._models_panel.paths()
            if not clothes or not models:
                QMessageBox.warning(self, "提示", "请先添加服装图和模特姿态图")
                return
            tasks = [([c, m], prompt) for c in clothes for m in models]
        else:
            p1, p2 = self._zone1.path(), self._zone2.path()
            if not p1 or not p2:
                QMessageBox.warning(self, "提示", "请先选择两张图片")
                return
            tasks = [([p1, p2], prompt)]

        self._output_dir = output_dir
        self._dir_input.setText(output_dir)
        self._result_area.clear()
        self._log_list.clear()
        self._progress_bar.setValue(0)
        self._task_label.setText(f"任务数：{len(tasks)}")
        self._start_btn.setEnabled(False)
        self._cancel_btn.setEnabled(True)
        self._open_dir_btn.setEnabled(True)

        self._thread = QThread()
        self._worker = BatchWorker()
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(
            lambda: self._worker.run_tasks(
                tasks, api_key, api_group, output_dir, concurrency,
            )
        )
        self._worker.signals.progress.connect(self._on_progress)
        self._worker.signals.finished.connect(self._on_finished)
        self._worker.signals.error.connect(self._on_error)
        self._worker.signals.all_done.connect(self._on_all_done)
        self._thread.finished.connect(self._thread.deleteLater)
        self._thread.start()

    def _on_cancel(self):
        if self._worker:
            self._worker.cancel()
        self._log("操作已取消")

    def _on_progress(self, current: int, total: int, message: str):
        self._progress_bar.setMaximum(total)
        self._progress_bar.setValue(current)
        self._task_label.setText(f"任务数：{total}  已完成：{current}")
        if message:
            self._log(message)

    def _on_finished(self, path: str, _data: bytes):
        pixmap = QPixmap(path)
        if pixmap.isNull():
            return
        item = QListWidgetItem(
            QIcon(pixmap.scaled(120, 120, Qt.KeepAspectRatio, Qt.SmoothTransformation)),
            os.path.basename(path),
        )
        self._result_area.addItem(item)

    def _on_error(self, desc: str, error: str):
        self._log(f"失败 {desc}: {error}")

    def _on_all_done(self, success: int, fail: int, output_dir: str):
        if self._thread:
            self._thread.quit()
            self._thread.wait(3000)
            self._thread = None
            self._worker = None
        self._start_btn.setEnabled(True)
        self._cancel_btn.setEnabled(False)
        self._log(f"全部完成：成功 {success} 个，失败 {fail} 个")
        if fail == 0:
            QMessageBox.information(self, "完成", f"全部 {success} 个任务处理完毕！")
        else:
            QMessageBox.warning(
                self, "完成",
                f"成功 {success} 个，失败 {fail} 个。\n"
                f"请查看日志了解详情。",
            )

    def _log(self, msg: str):
        self._log_list.addItem(msg)
        self._log_list.scrollToBottom()

    def _open_output_dir(self):
        if self._output_dir and os.path.isdir(self._output_dir):
            os.startfile(self._output_dir)
