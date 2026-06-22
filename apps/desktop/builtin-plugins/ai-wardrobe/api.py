"""AI 换装批量版 - API 调用

计费/中转改造（见 docs/billing-and-relay-design.md §11）：
  - 移除硬编码第三方 key 与地址（旧版直连 47.112.8.9:19081，违反需求 #3 且无法计费）。
  - 改为经「灵坊平台中转」调用：从环境变量读 LF_API_BASE（后端基址）+ LF_AUTH_TOKEN（登录态 JWT
    或平台 API Key），POST {LF_API_BASE}/api/relay/v1/images/edits，按张扣团队灵石。
  - 宿主在拉起 Python 插件进程时注入 LF_API_BASE / LF_AUTH_TOKEN（见 plugin_runner minimal_env 扩展）。
  - 缺失环境变量时抛清晰错误，绝不回退任何硬编码凭据。
"""
import io
import os
import base64
import time
from typing import Optional

import requests
from PIL import Image

from templates import PROMPT_MAP

# 平台中转地址与凭据来自环境变量（由宿主注入）。绝不硬编码第三方 key/地址。
MODEL = "premium"  # 前台版本哨兵（fast/premium），relay 解析为真实上游模型
DEFAULT_TIER_QUERY = "premium"
MAX_RETRIES = 3
BASE_DELAY = 2.0
REQUEST_TIMEOUT = 60


class ApiError(Exception):
    """API 调用异常"""
    pass


def build_prompt(mode: str) -> str:
    """根据模式名称获取对应 prompt 模板。"""
    return PROMPT_MAP[mode]


def _relay_config() -> tuple[str, str]:
    """读取平台中转配置：返回 (relay_url, auth_token)。缺失抛 ApiError。"""
    base = os.environ.get("LF_API_BASE", "").rstrip("/")
    token = os.environ.get("LF_AUTH_TOKEN", "")
    if not base or not token:
        raise ApiError(
            "未配置平台中转凭据（LF_API_BASE / LF_AUTH_TOKEN）。"
            "请在灵坊客户端「设置 → 模型与计费」确认已登录并连接平台后重试。"
        )
    return f"{base}/api/relay/v1/images/edits", token


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
    size: Optional[str] = None,
) -> bytes:
    """调用平台中转的图像编辑 API，返回第一张结果图的 PNG 字节数据。

    经 /api/relay/v1/images/edits 转发，按张扣团队灵石（凭据从环境变量读取）。
    """
    last_error: Optional[Exception] = None
    for attempt in range(MAX_RETRIES):
        try:
            return _do_call(image_paths, prompt, size)
        except (requests.RequestException, ApiError) as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(BASE_DELAY * (2**attempt))
    raise ApiError(f"经过{MAX_RETRIES}次重试仍失败: {last_error}")


def _do_call(
    image_paths: list[str],
    prompt: str,
    size: Optional[str],
) -> bytes:
    """执行单次平台中转请求（不含重试）。"""
    relay_url, token = _relay_config()
    entries: list[tuple[str, bytes]] = []
    for p in image_paths:
        entries.append(_open_as_png(p))

    files = [
        ("image[]", (name, data, "image/png"))
        for name, data in entries
    ]

    # model 取前台版本哨兵（fast/premium）；relay 解析为真实上游模型并计费。
    data: dict[str, object] = {"model": MODEL, "prompt": prompt}
    if size:
        data["size"] = size

    headers = {"Authorization": f"Bearer {token}"}

    resp = requests.post(
        relay_url,
        headers=headers,
        files=files,
        data=data,
        params={"model": DEFAULT_TIER_QUERY},
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
