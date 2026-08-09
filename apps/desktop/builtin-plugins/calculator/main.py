# -*- coding: utf-8 -*-
# =============================================================================
# 计算器插件入口（runtime_type: python）
# -----------------------------------------------------------------------------
# Tkinter（Python 标准库自带）实现的桌面计算器。零第三方依赖、零联网安装，
# 由桌面壳 start_plugin 命令在 %LOCALAPPDATA%/LingFang/python-venvs 下创建
# venv 后 detached 运行 `python -u main.py`，开箱即跑。
#
# 界面在进程自己弹出的独立窗口（平台对 python/nodejs 插件只做启动器 + 进程监视），
# stdin/stdout 不参与交互，故全部交互走 Tk 事件循环。
#
# 仅依赖标准库（Tkinter），无 requirements.txt。
# =============================================================================

import re
import tkinter as tk
from tkinter import font as tkfont

# 显示符号 → Python eval 安全字符的映射。用显示符号让 UI 友好，求值前还原。
_SYM_MAP = {"×": "*", "÷": "/", "−": "-", " ": ""}

# 安全表达式字符集：数字、运算符、括号、小数点。eval 前校验，杜绝注入。
_SAFE_EXPR = re.compile(r"^[0-9+\-*/(). ]*$")

# 按键布局：5 行 × 4 列，从上到下、从左到右。
_LAYOUT = [
    ("C", "⌫", "(", ")"),
    ("7", "8", "9", "÷"),
    ("4", "5", "6", "×"),
    ("1", "2", "3", "−"),
    ("0", ".", "=", "+"),
]

# 深色主题配色（对应原 PySide6 QSS）。
_BG = "#1f2026"
_BTN_BG = "#2c2e36"
_BTN_ACTIVE = "#3c3f4a"
_FG = "#e8eaed"
_FG_DIM = "#9aa0a6"
_FG_OP = "#f0b429"   # 运算符
_FG_FN = "#ef5350"   # 功能键
_EQ_BG = "#4285f4"   # 等号
_EQ_FG = "#ffffff"


def _normalize(expr: str) -> str:
    """把显示表达式还原为 Python 可求值的字符串。"""
    out = expr
    for sym, rep in _SYM_MAP.items():
        out = out.replace(sym, rep)
    return out


def evaluate(expr: str) -> str:
    """安全求值：仅允许数字/四则运算符/括号/小数点。返回结果字符串或错误提示。"""
    norm = _normalize(expr)
    if not norm:
        return ""
    if not _SAFE_EXPR.fullmatch(norm):
        return "错误"
    # 结尾是运算符/左括号时，求值会抛异常 → 统一返回"错误"。
    try:
        value = eval(norm, {"__builtins__": {}}, {})  # noqa: S307 - 已正则白名单校验
    except ZeroDivisionError:
        return "不能除以零"
    except Exception:
        return "错误"
    # 整数结果去掉小数尾零，避免 5.0。
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value)


class Calculator:
    def __init__(self, root: tk.Tk) -> None:
        self._root = root
        root.title("计算器")
        root.configure(bg=_BG)
        self._expr = ""
        self._build_ui()
        self._center(340, 520)

    # ------------------------------------------------------------------
    # UI 构建
    # ------------------------------------------------------------------
    def _center(self, width: int, height: int) -> None:
        screen_w = self._root.winfo_screenwidth()
        screen_h = self._root.winfo_screenheight()
        x = (screen_w - width) // 2
        y = (screen_h - height) // 3
        self._root.geometry(f"{width}x{height}+{x}+{y}")

    def _build_ui(self) -> None:
        display_font = tkfont.Font(family="Segoe UI", size=38)
        expr_font = tkfont.Font(family="Segoe UI", size=13)
        btn_font = tkfont.Font(family="Segoe UI", size=18)

        # 历史表达式行（小号灰字，显示输入过程）。
        self._expr_label = tk.Label(
            self._root, text="", bg=_BG, fg=_FG_DIM, font=expr_font,
            anchor="e", padx=16, pady=2,
        )
        self._expr_label.pack(fill="x", padx=16, pady=(18, 0))

        # 主显示行（大号白字，显示当前结果/输入）。
        self._display = tk.Label(
            self._root, text="0", bg=_BG, fg=_FG, font=display_font,
            anchor="e", padx=16, pady=4,
        )
        self._display.pack(fill="x", padx=16)

        # 按键网格：行 / 列等权重，保持键盘比例稳定。
        grid = tk.Frame(self._root, bg=_BG)
        grid.pack(expand=True, fill="both", padx=16, pady=(6, 16))
        for i in range(5):
            grid.rowconfigure(i, weight=1, uniform="row")
        for i in range(4):
            grid.columnconfigure(i, weight=1, uniform="col")
        for r, row in enumerate(_LAYOUT):
            for c, text in enumerate(row):
                btn = self._make_btn(grid, text, btn_font)
                btn.grid(row=r, column=c, padx=5, pady=5, sticky="nsew")

    def _make_btn(self, parent: tk.Frame, text: str, font: tkfont.Font) -> tk.Button:
        # 角色配色：等号 / 运算符 / 功能键 / 数字。
        if text == "=":
            bg, fg, active = _EQ_BG, _EQ_FG, "#3b74d8"
        elif text in ("÷", "×", "−", "+"):
            bg, fg, active = _BTN_BG, _FG_OP, _BTN_ACTIVE
        elif text in ("C", "⌫"):
            bg, fg, active = _BTN_BG, _FG_FN, _BTN_ACTIVE
        else:
            bg, fg, active = _BTN_BG, _FG, _BTN_ACTIVE
        return tk.Button(
            parent, text=text, font=font,
            bg=bg, fg=fg, activebackground=active, activeforeground=fg,
            relief="flat", bd=0, highlightthickness=0,
            command=lambda t=text: self._on_key(t),
        )

    # ------------------------------------------------------------------
    # 按键处理
    # ------------------------------------------------------------------
    def _on_key(self, key: str) -> None:
        if key == "C":
            self._expr = ""
            self._refresh("0")
        elif key == "⌫":
            self._expr = self._expr[:-1]
            self._refresh(self._expr or "0")
        elif key == "=":
            result = evaluate(self._expr)
            # 保留上一表达式到小字行，主行显示结果。
            self._expr_label.config(text=(self._expr + " =") if self._expr else "")
            self._expr = "" if result in ("错误", "不能除以零") else result
            self._display.config(text=result if result else "0")
        else:
            self._expr += key
            self._refresh(self._expr)

    def _refresh(self, display: str) -> None:
        self._display.config(text=display)
        self._expr_label.config(text=self._expr)


def main() -> None:
    root = tk.Tk()
    Calculator(root)
    root.mainloop()


if __name__ == "__main__":
    main()