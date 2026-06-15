"""AI 换装批量版 - 入口"""

import sys
from PySide6.QtWidgets import QApplication
from ui import MainWindow


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("AI 换装批量版")
    app.setApplicationDisplayName("AI 换装批量版")
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
