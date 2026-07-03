# 内置运行时预装包（preset）

灵方桌面端把 Python、Node 运行时随应用打包进 `apps/desktop/runtimes/`，供 AI
创建的插件离线运行。本目录定义这两个内置运行时**预装哪些常用包**，让插件开箱即用，
不必每次联网现装基础依赖。

## 文件

| 文件 | 作用 |
| --- | --- |
| `requirements.txt` | Python 预装清单（带版本范围，人工维护的“想要什么”） |
| `requirements.lock.txt` | Python 精确锁定版本（`pip freeze --all` 产出，复现/审计用） |
| `node-globals.json` | Node 全局预装清单（仅工具链：typescript、tsx） |
| `install-presets.ps1` | Windows 安装脚本（打包前执行一次） |
| `install-presets.sh` | 类 Unix 安装脚本 |

## 当前预设档位

- **Python：轻量通用** —— requests、httpx、beautifulsoup4、lxml、PyYAML、
  python-dateutil、openpyxl、pillow。约 +49MB site-packages。
  覆盖网络请求 / HTML 解析 / 配置 / 日期 / Excel / 图片，刻意不含 numpy/pandas/scipy
  等大型科学计算库以保持安装包体积。
- **Node：仅工具链** —— typescript、tsx。让 TS 插件能直接 `tsc`/`tsx` 运行。
  不全局装 axios/lodash 等运行时库：Node 默认 `require` 不解析全局包目录，运行时库应由
  插件自身 `package.json` 本地安装。

## 重新安装 / 升级流程

预装产物（`runtimes/python/Lib/site-packages`、`runtimes/nodejs/node_modules` 全局包）
**已随仓库提交**。需要调整时：

1. 改 `requirements.txt`（Python）或 `node-globals.json`（Node）。
2. 执行安装脚本：
   - Windows：`pwsh apps/desktop/runtimes/preset/install-presets.ps1`
   - 类 Unix：`bash apps/desktop/runtimes/preset/install-presets.sh`
   - 可加 `--skip-python` / `--skip-node`（sh）或 `-SkipPython` / `-SkipNode`（ps1）。
3. 重新生成 Python 锁定文件：
   `apps/desktop/runtimes/python/python.exe -m pip freeze --all > requirements.lock.txt`
   （记得把 `pip @ file://...` 那行手动改回 `pip==<版本>`）。
4. 提交 `runtimes/` 变更。

## 镜像源

脚本与 `src-tauri/src/embedded_runtime.rs` 中的常量保持一致：

- pip：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`
- npm：`https://registry.npmmirror.com`

## 运行时如何被插件使用

`EmbeddedRuntime`（`src-tauri/src/embedded_runtime.rs`）把 `runtimes/nodejs`、
`runtimes/python`、各自的 `Scripts`/`bin` 注入子进程 PATH。因此：

- `python`/`pip`/`node`/`npm`/`pnpm` 经 `resolve_runtime_command` 强制走内置运行时。
- `tsc`/`tsx` 等工具链命令作为非内置命令名，经注入的 PATH（含 `runtimes/nodejs`）解析到
  本目录预装的全局 shim。
