"""AI 换装批量版 - 自定义控件"""

import os

from PySide6.QtCore import Qt, Signal, QSize
from PySide6.QtGui import QPixmap, QDragEnterEvent, QDropEvent, QIcon
from PySide6.QtWidgets import (
    QLabel, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QListWidget, QListWidgetItem,
    QFileDialog, QSizePolicy,
)


class DropZone(QLabel):
    """拖拽/点击放置图片的控件，支持单张图片。"""
    image_dropped = Signal(str)

    def __init__(self, label_text: str, parent=None):
        super().__init__(parent)
        self._path: str | None = None
        self.setAcceptDrops(True)
        self.setAlignment(Qt.AlignCenter)
        self.setText(label_text)
        self.setStyleSheet("""
            QLabel {
                border: 2px dashed #bbb;
                border-radius: 10px;
                padding: 16px;
                background: #f9f9f9;
                min-width: 200px;
                min-height: 200px;
                font-size: 14px;
                color: #666;
            }
            QLabel:hover {
                border-color: #4a90d9;
                background: #f0f6ff;
            }
        """)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

    def set_image(self, path: str):
        self._path = path
        pixmap = QPixmap(path)
        if not pixmap.isNull():
            scaled = pixmap.scaled(280, 280, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            self.setPixmap(scaled)
        else:
            self.setText(f"无法加载图片\n{path}")

    def clear_image(self):
        self._path = None
        self.setPixmap(QPixmap())
        self.setText("点击选择或拖拽图片到此处")

    def path(self) -> str | None:
        return self._path

    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent):
        urls = event.mimeData().urls()
        if urls:
            path = urls[0].toLocalFile()
            if path.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".webp")):
                self.set_image(path)
                self.image_dropped.emit(path)

    def mousePressEvent(self, event):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择图片", "",
            "图片文件 (*.png *.jpg *.jpeg *.bmp *.webp)",
        )
        if path:
            self.set_image(path)
            self.image_dropped.emit(path)


class ImageListPanel(QWidget):
    """可添加/删除多张图片的列表面板，用于批量模式。"""
    images_changed = Signal()

    def __init__(self, title: str, max_images: int, parent=None):
        super().__init__(parent)
        self._max = max_images
        self._paths: list[str] = []

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        header = QHBoxLayout()
        header.addWidget(QLabel(f"{title}（最多{max_images}张）"))
        header.addStretch()

        self._add_btn = QPushButton("+ 添加")
        self._add_btn.clicked.connect(self._on_add)
        header.addWidget(self._add_btn)

        self._clear_btn = QPushButton("清空")
        self._clear_btn.clicked.connect(self._clear)
        header.addWidget(self._clear_btn)
        layout.addLayout(header)

        self._list = QListWidget()
        self._list.setViewMode(QListWidget.IconMode)
        self._list.setIconSize(QSize(80, 80))
        self._list.setMovement(QListWidget.Static)
        self._list.setMaximumHeight(200)
        self._list.setContextMenuPolicy(Qt.CustomContextMenu)
        self._list.customContextMenuRequested.connect(self._on_context_menu)
        layout.addWidget(self._list)

    def _on_add(self):
        if len(self._paths) >= self._max:
            return
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择图片", "",
            "图片文件 (*.png *.jpg *.jpeg *.bmp *.webp)",
        )
        for p in paths:
            if len(self._paths) >= self._max:
                break
            if p not in self._paths:
                self._paths.append(p)
                self._add_thumbnail(p)
        self.images_changed.emit()

    def _add_thumbnail(self, path: str):
        pixmap = QPixmap(path)
        if pixmap.isNull():
            return
        item = QListWidgetItem(QIcon(pixmap.scaled(80, 80, Qt.KeepAspectRatio, Qt.SmoothTransformation)),
                               os.path.basename(path))
        item.setData(Qt.UserRole, path)
        self._list.addItem(item)

    def _clear(self):
        self._paths.clear()
        self._list.clear()
        self.images_changed.emit()

    def _on_context_menu(self, pos):
        item = self._list.itemAt(pos)
        if item is None:
            return
        path = item.data(Qt.UserRole)
        if path in self._paths:
            self._paths.remove(path)
        self._list.takeItem(self._list.row(item))
        self.images_changed.emit()

    def paths(self) -> list[str]:
        return list(self._paths)

    def count(self) -> int:
        return len(self._paths)
