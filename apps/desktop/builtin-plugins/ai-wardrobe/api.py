"""AI 换装批量版 - API 调用"""

import io
import os
import base64
import time
from typing import Optional

import requests
from PIL import Image

from templates import PROMPT_MAP

API_URL = "http://47.112.8.9:19081/v1/images/edits"
MODEL = "gpt-image-2"
DEFAULT_KEY = "sk-sQXtwgZlIFnvR2dvpgnOz7vj1gYhyxqFV6picL8iJk2lFKOO"
MAX_RETRIES = 3
BASE_DELAY = 2.0
REQUEST_TIMEOUT = 60


class ApiError(Exception):
    """API 调用异常"""
    pass


def build_prompt(mode: str) -> str:
    """根据模式名称获取对应 prompt 模板。"""
    return PROMPT_MAP[mode]


def _open_as_png(path: str) -> tuple[str, bytes]:
    """将图片文件读取为 PNG 格式的字节数据。

    如果源文件不是 PNG，自动用 Pillow 转换。
    返回 (规范文件名, PNG 字节数据)。
    """
    ext = os.path.splitext(path)[1].lower()
    base_name = os.path.splitext(os.path.basename(path))[0]
    if ext == ".png":
        with open(path, "rb") as f:
            return f"{base_name}.png", f.read()
    with Image.open(path) as img:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return f"{base_name}.png", buf.getvalue()


def call_edit_api(
    image_paths: list[str],
    prompt: str,
    api_key: str = DEFAULT_KEY,
    api_group: str = "default",
    size: Optional[str] = None,
) -> bytes:
    """调用图像编辑 API，返回第一张结果图的 PNG 字节数据。

    Args:
        image_paths: 图片路径列表（顺序对应 image[]）。
        prompt: 提示词。
        api_key: API 密钥。
        api_group: 分组标识（default/A1/A2/A3）。
        size: 可选输出尺寸，如 "1024x1024"。

    Returns:
        PNG 图片二进制数据。

    Raises:
        ApiError: 重试耗尽后抛出。
    """
    last_error: Optional[Exception] = None
    for attempt in range(MAX_RETRIES):
        try:
            return _do_call(image_paths, prompt, api_key, api_group, size)
        except (requests.RequestException, ApiError) as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(BASE_DELAY * (2**attempt))
    raise ApiError(f"经过{MAX_RETRIES}次重试仍失败: {last_error}")


def _do_call(
    image_paths: list[str],
    prompt: str,
    api_key: str,
    api_group: str,
    size: Optional[str],
) -> bytes:
    """执行单次 API 请求（不含重试）。"""
    entries: list[tuple[str, bytes]] = []
    for p in image_paths:
        entries.append(_open_as_png(p))

    files = [
        ("image[]", (name, data, "image/png"))
        for name, data in entries
    ]

    data: dict[str, object] = {"model": MODEL, "prompt": prompt}
    if size:
        data["size"] = size

    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-API-Group": api_group,
    }

    resp = requests.post(
        API_URL,
        headers=headers,
        files=files,
        data=data,
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    result = resp.json()

    data_list = result.get("data", [])
    if not data_list:
        raise ApiError("API 响应 data 为空")

    first = data_list[0]
    if "b64_json" in first:
        return base64.b64decode(first["b64_json"])
    if "url" in first:
        img_resp = requests.get(first["url"], timeout=REQUEST_TIMEOUT)
        img_resp.raise_for_status()
        return img_resp.content
    raise ApiError("API 响应中既无 b64_json 也无 url")
