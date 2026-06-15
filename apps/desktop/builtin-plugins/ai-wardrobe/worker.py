"""AI 换装批量版 - 后台工作器"""

import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from PySide6.QtCore import QObject, Signal

from api import call_edit_api, ApiError


class WorkerSignals(QObject):
    """工作线程信号"""
    progress = Signal(int, int, str)   # current, total, message
    finished = Signal(str, bytes)      # output_path, image_data
    error = Signal(str, str)           # task_desc, error_msg
    all_done = Signal(int, int, str)   # success, fail, output_dir


def _make_filename(image_paths: list[str]) -> str:
    """根据输入图片名称和时间戳生成输出文件名。"""
    parts = [
        os.path.splitext(os.path.basename(p))[0]
        for p in image_paths
    ]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    return "_".join(parts + [ts]) + ".png"


class BatchWorker(QObject):
    """在 QThread 中运行的批量处理工作器。
    内部使用 ThreadPoolExecutor 实现并发请求。
    """
    signals = WorkerSignals()

    def __init__(self):
        super().__init__()
        self._cancel_event = threading.Event()

    def cancel(self):
        """取消所有进行中的任务。"""
        self._cancel_event.set()

    def run_tasks(
        self,
        tasks: list[tuple[list[str], str]],
        api_key: str,
        api_group: str,
        output_dir: str,
        max_workers: int = 4,
    ):
        """执行一组任务。

        Args:
            tasks: [(image_paths, prompt), ...]
            api_key: API 密钥
            api_group: API 分组
            output_dir: 输出目录
            max_workers: 最大并发数
        """
        self._cancel_event.clear()
        total = len(tasks)
        lock = threading.Lock()
        completed = 0
        success = 0
        fail = 0

        def _process(image_paths: list[str], prompt: str):
            nonlocal completed, success, fail
            if self._cancel_event.is_set():
                return

            desc = " x ".join(os.path.basename(p) for p in image_paths)
            try:
                img_data = call_edit_api(
                    image_paths, prompt,
                    api_key=api_key, api_group=api_group,
                )
                filename = _make_filename(image_paths)
                output_path = os.path.join(output_dir, filename)

                os.makedirs(output_dir, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(img_data)

                with lock:
                    completed += 1
                    success += 1
                    self.signals.progress.emit(
                        completed, total,
                        f"[{completed}/{total}] 完成: {filename}",
                    )
                    self.signals.finished.emit(output_path, img_data)

            except ApiError as e:
                with lock:
                    completed += 1
                    fail += 1
                    self.signals.progress.emit(
                        completed, total,
                        f"[{completed}/{total}] 失败: {desc}",
                    )
                    self.signals.error.emit(desc, str(e))

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [
                pool.submit(_process, paths, prompt)
                for paths, prompt in tasks
            ]
            for f in as_completed(futures):
                if self._cancel_event.is_set():
                    break
                f.result()

        self.signals.all_done.emit(success, fail, output_dir)
