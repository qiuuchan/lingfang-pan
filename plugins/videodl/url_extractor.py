# -*- coding: utf-8 -*-
# =============================================================================
# URL 提取器（纯标准库，无新依赖）
# -----------------------------------------------------------------------------
# 用户从 App 分享面板复制的文字几乎都「不干净」，典型如小红书：
#     夏季体制内OOTD💼极简大方✨同事们都夸好看！ http://xhslink.com/o/34X3YhBZG5z 【小红书】笔记已就绪，复制后即可查看~
# 直接把这种字符串丢给 videofetch 解析，它会按 URL 规则去请求，host 取不准、
# 中文/emoji/【】等字符干扰协议判定，解析成功率很低甚至触发上游 NoneType 崩溃。
#
# 本模块负责「先把第一个有效 URL 干净地抠出来」，再把纯 URL 交给 videofetch，
# 显著提升解析稳健性（尤其针对含短链 + 大段中文描述的分享文案）。
#
# 设计目标：
#   1. 纯标准库（re + urllib），不增加 requirements.txt 体积。
#   2. 只抠第一个 URL —— 视频解析场景一次解析一条链接，多了反而歧义。
#   3. 宽进严出：先正则宽松捞候选，再用 urllib 严格校验 scheme/host。
# =============================================================================

import re
from urllib.parse import urlparse


# 宽松的 URL 抓取正则：
#   - 仅 http/https（ftp/mailto 等对视频下载无意义，排除以降噪）
#   - 允许 URL 前后紧贴任意非空白字符（中文/emoji/标点），由 [^\s]+ 贪婪匹配，
#     再由 _clean_url_tail 去掉末尾常见标点。
#   - (?<!\w) 防止把 "abchttp://..." 中的后半段误判为独立 URL。
_URL_PATTERN = re.compile(r"(?<!\w)(https?://[^\s<>'\"]+)", re.IGNORECASE)


# URL 末尾常被分享文案「粘」上的中文/英文标点，逐一回退剥离。
# 覆盖：中文全角括号、英文括号/方括号/引号、句号逗号等。同时去掉因成对剥离
# 产生的多余尾部。注意：右括号在合法 URL 里几乎不出现，剥离安全。
_TRAILING_CHARS = ".,;:!?。，；：！？、）)】]】》>\"'）"
# 成对收尾（如「...】...」分享文案常见），剥离尾部成对符号，避免误删括号内 URL。
_RIGHT_PAREN_PAIRS = [("（", "）"), ("(", ")"), ("【", "】"), ("[", "]"), ("《", "》")]


def _clean_url_tail(url: str) -> str:
    """剥离 URL 末尾被分享文案粘连的标点（中英文全角半角）。

    从末尾逐字符回退剥离；遇到成对的左括号仍残留在 URL 内时停止剥离对应右括号，
    避免破坏如 `http://x.com/a(b)c` 这类合法但少见的 URL。
    """
    # 先处理成对的右括号：仅当 URL 中已无对应左括号时，右括号才是「多余的尾巴」。
    cleaned = url
    for left, right in _RIGHT_PAREN_PAIRS:
        while cleaned.endswith(right) and cleaned.count(left) < cleaned.count(right):
            cleaned = cleaned[: -len(right)]
    # 再剥离常见尾部标点。
    while cleaned and cleaned[-1] in _TRAILING_CHARS:
        cleaned = cleaned[:-1]
    return cleaned


def extract_first_url(text: str):
    """从任意文本中提取第一个有效的 http(s) URL。

    Returns:
        str:  提取到的「干净 URL」（已剥离尾部粘连标点），可直接交给 videofetch。
        None: 文本里没有有效 http(s) URL。
    """
    if not text:
        return None
    for match in _URL_PATTERN.finditer(text):
        candidate = _clean_url_tail(match.group(1))
        # 用 urlparse 严格校验：必须有 scheme 且为 http/https，且必须有非空 host。
        parsed = urlparse(candidate)
        if parsed.scheme.lower() in ("http", "https") and parsed.netloc:
            return candidate
    return None


if __name__ == "__main__":  # 简单自测：python url_extractor.py
    cases = [
        "夏季体制内OOTD💼极简大方✨同事们都夸好看！ http://xhslink.com/o/34X3YhBZG5z 【小红书】笔记已已绪，复制后即可查看~",
        "看看这个 https://www.bilibili.com/video/BV1xx411c7mD 哈哈",
        "纯文字没有链接",
        "   https://www.youtube.com/watch?v=dQw4w9WgXcQ   ",
        "两个链接 http://a.com/1 和 http://b.com/2 应取第一个",
        "【抖音】https://v.douyin.com/AbCdEf123/ 复制打开抖音",
        "括号包裹（https://example.com/path?q=1）尾标点",
    ]
    for c in cases:
        print(f"输入: {c!r}")
        print(f"输出: {extract_first_url(c)!r}")
        print("-" * 60)
