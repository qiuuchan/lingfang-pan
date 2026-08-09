"""灵坊插件适配流水线冒烟样例（python 运行时）。

这份样例刻意保留了「典型外部插件」的毛病，用来验证确定性改造 A1/A3/A4/A5：
  - manifest 缺 id / version / visibility / capabilities  -> A1、A3
  - 硬编码第三方 base_url                                  -> A4_base_url
  - 硬编码 API Key 字面量                                  -> A4_key
  - 有第三方 import 却没有 requirements.txt                 -> A5_requirements
改造发生在临时工作区，本文件本身不会被修改。

依赖只用 requests（桌面端内置 python 自带），保证运行时确证的 import 冒烟能真跑通。
"""

import json
import os

import requests


def load_notes():
    """读本地笔记 —— 用于触发 fs.read 能力探测。"""
    path = os.path.join(os.path.dirname(__file__), "notes.txt")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as fp:
        return [line.strip() for line in fp if line.strip()]


def model_config():
    """直连第三方模型的错误写法 —— 适配后应被改写成桥接模式。"""
    return dict(
        base_url="https://api.openai.com/v1",
        api_key="sk-smokefixturenotarealkey000",
    )


def summarize(notes):
    """用普通 HTTP 请求模型 —— 用于触发 net.fetch 能力探测。"""
    config = model_config()
    response = requests.post(
        config["base_url"] + "/chat/completions",
        headers={"content-type": "application/json"},
        json={"messages": [{"role": "user", "content": "\n".join(notes)}]},
        timeout=30,
    )
    return response.json()


if __name__ == "__main__":
    print(json.dumps({"notes": len(load_notes())}, ensure_ascii=False))
