# 视频下载器插件（videodl）

基于 [videofetch](https://github.com/CharlesPikachu/videodl)（GitHub: CharlesPikachu/videodl）+ PySide6 的视频下载 GUI。

> 仅用于学习用途。请遵守各视频平台版权与会员规则。videofetch 采用 PolyForm-Noncommercial-1.0.0 协议（禁止商用）。

## 功能

- 粘贴视频链接 → 解析 → 列表多选 → 下载到指定目录。
- 支持 100+ 平台（B站 / 抖音 / YouTube / 快手 / 小红书 / 微博 / 西瓜 / 知乎 等）+ 40+ 通用解析接口（解析失败时自动回退）。
- 解析、下载在后台线程进行，不阻塞界面。

## 使用

1. 在灵方桌面「插件中心 → 本地插件」点「导入」，选择本插件目录（含 `manifest.json`）。
2. 导入后列表出现「视频下载器」，点「打开」首次运行（自动 `pip install videofetch + PySide6`，约 100MB+，几十秒）。
3. 窗口弹出后粘贴链接 → 点「解析」→ 选择要下载的视频 → 点「下载选中」。

## 系统依赖（可选但强烈建议）

- **FFmpeg**：HLS 源（B站 / 腾讯视频 / 爱奇艺等）需系统 PATH 上有 `ffmpeg`。直接 mp4 源不受影响。
  - 验证：终端运行 `ffmpeg -version` 能输出版本号。
- **N_m3u8DL-RE**（可选）：处理加密/防盗链 m3u8 更强更快。装好后在 PATH 可用 `N_m3u8DL-RE --version`。

> 桌面启动插件时会保留系统 PATH，故系统级安装的 FFmpeg / N_m3u8DL-RE 可被 videofetch 调用。启动时若检测不到 FFmpeg 会在日志区给出提示。

## 文件结构

```
videodl/
├── manifest.json       # 插件清单（runtime_type: python）
├── main.py             # PySide6 GUI 入口
├── requirements.txt    # videofetch + PySide6
└── README.md
```

## 运行类型

`runtime_type: python` → 由桌面壳 `start_plugin` 在独立 venv 中 `python -u main.py` 运行，GUI 自弹独立窗口。stdin/stdout 不参与交互。
