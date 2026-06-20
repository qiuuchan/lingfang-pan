# AI 换装批量版

基于 PySide6 的桌面 GUI 程序，通过远程图像编辑 API 实现服装换装/换内搭/换头/批量换装。

## 功能

- **换装（全套）**：将图 2 的全套服装换到图 1 身上
- **换内搭**：为图 1 模特穿上图 2 所示内搭
- **换头**：将图 2 的头像换到图 1 人物身上
- **批量换装**：服装图（最多 3 张）× 模特姿态图（最多 20 张）笛卡尔积批量处理

## 安装依赖

```bash
软件会使用内置 Python 自动创建 .venv 并安装 requirements.txt。
```

## 运行

```bash
在 LingFang 桌面端侧边栏点击「AI 换装批量版」直接拉起。
```

插件运行只使用 LingFang 应用包内置 Python，不依赖系统解释器或系统启动器。

## 使用说明

1. 顶部选择模式（换装/换内搭/换头/批量换装）
2. 设置 API Key（已填入默认值）、API Group、并发数、输出目录
3. 根据模式添加图片：
   - 单人模式：拖拽或点击选择图 1、图 2
   - 批量模式：分别添加服装图（≤3 张）和模特姿态图（≤20 张）
4. 点击「开始处理」
5. 处理完成后结果图显示在预览区，可通过「打开输出目录」查看

## 目录结构

| 文件 | 行数 | 用途 |
|---|---|---|
| main.py | 16 | 程序入口，启动 QApplication |
| templates.py | 32 | 四种换装模式的 prompt 模板 |
| api.py | 107 | HTTP API 客户端（multipart 上传、重试、超时） |
| worker.py | 120 | 后台并发工作器（QThread + ThreadPoolExecutor） |
| widgets.py | 125 | 自定义控件（DropZone、ImageListPanel） |
| ui.py | 268 | 主窗口 UI 布局及事件处理 |
| requirements.txt | 3 | Python 依赖声明 |
| README.md | — | 本文件 |

## 技术栈

- **GUI 框架**: PySide6
- **HTTP 客户端**: requests
- **图像处理**: Pillow
- **并发**: threading + concurrent.futures.ThreadPoolExecutor
