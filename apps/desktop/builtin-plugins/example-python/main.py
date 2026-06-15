# -*- coding: utf-8 -*-
# =============================================================================
# 示例 Python 插件入口（runtime_type: python）
# -----------------------------------------------------------------------------
# 本文件是 LingFang 桌面壳「python 脚本型插件」的参考实现，供大模型生成 python
# 插件时对齐结构与约定。脚本由桌面壳 plugin_script::run_plugin_script 命令在
# app_data/plugin-sandbox/<plugin_id> 下落盘后用 `py -u main.py`（Windows）或
# `python3 -u main.py`（Unix）带超时一次性执行（无参数）。
#
# 关键约束（开发者务必遵守，否则预览/运行会失败）：
# 1. 仅可用 Python 标准库（os/sys/json/collections 等）。sandbox 无 site-packages，
#    第三方包需脚本内联或改走 cloud 运行时。
# 2. stdout 是唯一与用户交互的「结果通道」——桌面壳把 stdout 视为插件输出展示给用户；
#    stderr 仅用于诊断信息（不进主结果区）。故结构化结果请用 print 输出到 stdout。
# 3. 中文输出：Rust 侧已注入 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1 + PYTHONPATH=<sandbox根>，
#    故 print("中文") 不会乱码；多文件 import 也支持（见 pkg/ 示例，本例为单文件保持简洁）。
# 4. 文件头建议写 # -*- coding: utf-8 -*-（兼容 Python 2 风格声明，Python 3 已默认 UTF-8，
#    但写上无害且对部分旧工具友好）。
# 5. 禁止死循环 / input() 阻塞——run_plugin_script 默认 15s 超时后会强杀进程组（含孙进程）。
#    -u（无缓冲）已由宿主传入，print 无需手动 flush。
# 6. 脚本运行在用户权限下，等价于本地 `python main.py`：可读写用户文件、发起网络请求、
#    subprocess。请勿执行破坏性操作。
# =============================================================================

import json
import os
import platform
import sys
import time
from collections import Counter


# -----------------------------------------------------------------------------
# 示例功能：文本统计分析器——对一段示例文本做字数/词频/行数统计，
# 输出结构化 JSON 结果到 stdout。
# 选这个例子的理由：覆盖「输入解析 → 统计计算 → 结构化输出」典型数据处理场景，
# 且不依赖外部文件（纯内存），适合作为最小可运行模板。
# -----------------------------------------------------------------------------

SAMPLE_TEXT = """LingFang 是一个面向团队的本地优先协作平台。
桌面端支持插件扩展，插件可以用 HTML、Node.js 或 Python 编写。
本示例插件演示 Python 运行时的文本统计能力：字数、行数、词频。
插件通过 stdout 输出结果，宿主捕获后展示给用户。"""


def analyze_text(text: str) -> dict:
    """对输入文本做统计分析，返回结构化结果字典。

    统计维度：
    - 字符数（含/不含空白）
    - 行数
    - 词频 Top N（中文按字符、英文按单词，此处用简单的字符级统计演示）
    """
    char_count_total = len(text)
    char_count_no_ws = len(text.replace(" ", "").replace("\n", "").replace("\t", ""))
    line_count = text.count("\n") + 1

    # 词频统计：按空白拆分，统计每个 token 出现次数（中文场景字符级更准，
    # 这里用 split 演示基础能力，生产插件可用 jieba 等分词库——但需走 cloud 运行时）。
    tokens = [t for t in text.replace("。", " ").replace("，", " ").replace("：", " ").split() if t]
    token_freq = Counter(tokens)

    return {
        "charCount": char_count_total,
        "charCountNoWhitespace": char_count_no_ws,
        "lineCount": line_count,
        "tokenCount": len(tokens),
        "topTokens": [
            {"token": tok, "count": cnt} for tok, cnt in token_freq.most_common(5)
        ],
    }


def main() -> None:
    started_at = time.time()

    print("[示例 Python 插件] 开始文本统计分析")
    print(f"运行环境：Python {sys.version.split()[0]} | 平台 {platform.platform()} | PID {os.getpid()}")

    result_analysis = analyze_text(SAMPLE_TEXT)

    print("--- 处理结果 ---")
    print(f"字符数：{result_analysis['charCount']}（去空白 {result_analysis['charCountNoWhitespace']}）")
    print(f"行数：{result_analysis['lineCount']}")
    print(f"Token 数：{result_analysis['tokenCount']}")
    print("高频 Token Top 5：")
    for item in result_analysis["topTokens"]:
        print(f"  - {item['token']}：{item['count']} 次")

    # 结构化结果（一行 JSON，带前缀便于宿主提取）。
    elapsed_ms = int((time.time() - started_at) * 1000)
    result = {
        "plugin": "builtin.example-python",
        "runtime": "python",
        "processedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "elapsedMs": elapsed_ms,
        "summary": result_analysis,
    }
    print(f"RESULT_JSON: {json.dumps(result, ensure_ascii=False)}")

    # 诊断信息走 stderr（不污染 stdout 主结果区）。
    print(f"[诊断] Python 解释器：{sys.executable}", file=sys.stderr)
    print(f"[诊断] 耗时 {elapsed_ms}ms", file=sys.stderr)

    # 显式 exit 0 让宿主判定成功。
    sys.exit(0)


if __name__ == "__main__":
    main()
