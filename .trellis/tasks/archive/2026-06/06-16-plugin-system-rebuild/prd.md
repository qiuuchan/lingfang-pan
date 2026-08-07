# 插件系统全面重构（venv+独立文件夹+持久化+外部窗口+状态动态+pnpm）

## Goal（目标）

重新设计整个插件运行架构，从「临时 sandbox 预览」改为「持久化独立运行环境」。

## 新架构设计

### 三类插件各自的运行方式

| 类型               | 入口          | 运行方式                                    | UI 显示                         |
| ------------------ | ------------- | ------------------------------------------- | ------------------------------- |
| **HTML（CLIENT）** | ui/index.html | 软件内 iframe 显示（当前已有）              | iframe 内嵌                     |
| **Node.js**        | package.json  | `pnpm install && pnpm start` 在独立终端运行 | 软件「运行中」状态 + 可强制关闭 |
| **Python**         | main.py       | 独立 venv 环境 `venv/bin/python main.py`    | 软件「运行中」状态 + 可强制关闭 |

### 10 项需求（逐条）

#### 1. 插件名用户命名

- 插件名不自动从 manifest.name 取，由用户在创建时命名。
- 创建 UI 有「插件名称」输入框。
- manifest.name 仍保留（程序标识符），但 UI 展示用用户命名的 title。

#### 2. 插件状态动态获取

- 不硬编码"创建状态"。
- 状态根据插件文件分析动态判定：
  - `ready`：有完整入口文件 + manifest。
  - `incomplete`：缺入口文件或 manifest。
  - `error`：manifest 格式错误。
  - `running`：插件正在运行。
  - `stopped`：插件已停止。
- 状态从文件系统实时扫描获取（不存 DB）。

#### 3. Python venv 隔离运行

- 每个 Python 插件有独立 venv（`<插件目录>/.venv/`）。
- 运行前自动创建 venv + `pip install -r requirements.txt`（如果有）。
- 运行用 venv 内的 python：Windows `.\.venv\Scripts\python.exe main.py`，Unix `.venv/bin/python main.py`。

#### 4. 插件数据持久化

- 插件文件存在**持久化目录**（不是临时 sandbox），重启软件后还在。
- 每个插件有独立的 `<插件目录>/data/` 子目录存储运行数据（JSON/SQLite/文件等）。
- Python/Node/HTML 插件的数据都存在这里。

#### 5. Python = 单一 main.py + 外部窗口

- Python 插件只有 `main.py` 作为入口。
- 运行时作为**独立进程**启动（不嵌入软件 UI）。
- 如果是 GUI 应用（PyQt5/Tkinter 等），它会弹独立窗口。
- 软件内显示「插件运行中」+ 进程信息 + 「强制关闭」按钮。

#### 6. 每个插件独立文件夹 + 路径可配置

- 每个插件有独立文件夹：`<插件根目录>/<plugin-id>/`。
- 结构：
  ```
  plugins/           ← 插件根目录（设置页可配置路径，默认 app_data/plugins/）
  ├── my-clock/      ← 插件 1
  │   ├── manifest.json
  │   ├── main.py / index.js / ui/index.html
  │   ├── .venv/     ← Python venv（仅 Python 插件）
  │   ├── data/      ← 运行数据持久化
  │   └── node_modules/ ← Node 依赖（仅 Node 插件）
  ├── my-tool/       ← 插件 2
  └── ...
  ```
- 设置页加「插件存放路径」配置（默认 `app_data/plugins/`）。

#### 7. Node.js 用 pnpm 启动

- Node.js 插件有 `package.json`，运行前 `pnpm install`（如果有依赖）。
- 运行用 `pnpm start`（对应 package.json scripts.start）。
- 独立进程运行（同 Python，外部终端方式）。

#### 8. HTML 在软件内显示

- HTML 插件在软件插件区域用 iframe 显示（当前已有 iframe 预览，保留）。
- 不需要外部窗口。

#### 9. Python/Node 独立运行在外部

- Python/Node 插件作为**独立进程**运行（spawn 后 detach）。
- 软件只显示「运行中」状态 + 可监控/强制关闭。
- 不在软件 UI 内嵌入终端输出（运行输出在插件自己的窗口/控制台）。

#### 10. 沙盒在正确目录

- AI 生成插件时，workspace 目录应该是**插件的持久化目录**（不是 claude-sandbox 临时目录）。
- 生成的文件直接写入 `<插件根目录>/<plugin-id>/`。
- 不在别的项目目录生成文件。

## Constraints

- 简体中文。UTF-8 无 BOM。
- 不破坏现有的 HTML 插件 iframe 预览（保留）。
- CLI 生成插件的流程保留（claude/codex/opencode 生成代码），但文件写入目标改为插件持久化目录。
- venv 创建/pnpm install 失败时给出友好错误（不崩）。
- 设置页的「插件存放路径」改后，已有插件迁移（或提示用户手动迁移）。

## AC

- [ ] AC1 插件名由用户命名（不自动取 manifest.name）。
- [ ] AC2 插件状态动态判定（ready/incomplete/error/running/stopped），根据文件分析。
- [ ] AC3 Python 插件用 venv 运行（自动创建 .venv + pip install + venv python main.py）。
- [ ] AC4 插件数据持久化（重启不丢，data/ 子目录）。
- [ ] AC5 Python/Node 独立进程运行（外部窗口/终端），软件显示运行状态 + 可关闭。
- [ ] AC6 每个插件独立文件夹（plugins/<id>/）。
- [ ] AC7 设置页可配置插件存放路径。
- [ ] AC8 Node.js 用 pnpm install + pnpm start。
- [ ] AC9 HTML 在软件内 iframe 显示（保留）。
- [ ] AC10 AI 生成时文件写入插件持久化目录（不是临时 sandbox）。
- [ ] AC11 全量验证绿（cargo test + pnpm typecheck/test/build）。

## 实施顺序（Workflow 多组并行）

- **组A**：Rust 后端——插件目录管理（独立文件夹 + 路径配置 + 持久化）。
- **组B**：Rust 后端——Python venv 运行 + Node pnpm 运行 + 进程管理（独立窗口/关闭）。
- **组C**：前端——插件状态动态显示 + 插件名用户命名 + 运行/关闭 UI。
- **组D**：Rust 后端——AI 生成 workspace 改为插件持久化目录（不再临时 sandbox）。
