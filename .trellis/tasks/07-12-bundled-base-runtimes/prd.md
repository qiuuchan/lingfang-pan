# 安装包内置完整基础运行时

## Goal

让正式发布的桌面安装包默认携带插件执行所需的完整基础环境，使用户安装后无需另行下载或依赖宿主机环境，即可调用 Node.js、Python、FFmpeg 和 Chromium。

同时将“正式安装包必须内置完整基础运行时”沉淀为项目长期发布契约，避免后续版本再次切换回纯按需下载而没有显式产品决策。

## Confirmed Facts

- 当前 Tauri `bundle.resources` 为空，官方 NSIS 不包含任何运行时资源。
- 自制 SFX 打包脚本明确排除了脚本运行时。
- 当前 Python / Node.js 采用设置页按需下载，安装到用户本地数据目录。
- `RuntimeResolver` 不读取宿主 `PATH`；只认用户指定路径或应用管理目录。
- FFmpeg 虽保留解析和 PATH 注入接口，但当前解析固定为 `None`，也没有下载入口。
- Chromium 当前由声明 Playwright 依赖的插件首次运行时下载到 Playwright 用户缓存，没有统一的应用内置目录。
- 项目锁定的 Playwright 1.61.1 使用 Chromium revision 1228，并分别要求有界面 Chromium 与 `chromium-headless-shell`；二者必须作为同一个受管理 Chromium 运行时整体提供，不能用重命名同一 exe 的方式替代。
- 项目主要发布目标和现有打包脚本均为 Windows x64；用户确认本任务只交付 Windows x64。

## Requirements

- 正式 Windows x64 安装包必须包含可直接执行的 Node.js、Python、FFmpeg 和 Chromium。
- 安装完成后的首次插件执行不得因上述基础运行时触发网络下载。
- 插件及 Agent shell 必须通过应用管理的绝对路径或受控 `PATH` 命中内置运行时，不依赖宿主机全局安装。
- Python 必须包含可工作的 `pip`/`ensurepip`；Node.js 必须包含 `npm`，并满足现有 `pnpm` 调用约定。
- FFmpeg 必须同时支持绝对命令解析和插件子进程中的 `ffmpeg` 命令查找。
- Chromium 必须能被项目支持的 Playwright Node/Python 插件发现和启动，不再默认写入或依赖用户级 `ms-playwright` 缓存。
- 同一个受管理 Chromium 运行时必须同时支持 Playwright 有界面/无头自动化和插件直接执行 `chromium` / `chrome` 命令；不得再向用户级 Playwright 缓存下载第二套浏览器。
- 两条 Windows 发布链（官方 NSIS、自制 SFX）必须使用同一份运行时清单和已校验资源，防止产物能力分叉。
- 构建时必须固定版本、校验下载制品完整性，并在缺失资源时失败，不允许产出“看似成功但缺运行时”的安装包。
- Node.js、Python、FFmpeg、Chromium 的发布运行时文件必须提交进 Git，使不同电脑 clone/checkout 后无需先下载运行时即可开发和打包。
- 运行时二进制直接存入普通 Git 对象并推送现有 Gitee 仓库，不使用 Git LFS；沿用仓库此前提交内置运行时的方式。
- 开发模式与正式应用使用仓库中同一套内置运行时，不维护另一套本地下载目录。
- 安装包和仓库体积不设硬上限，优先保证完整、离线、开箱即用。
- 正式应用中的运行时来源唯一为安装包内置资源，不提供按需下载、卸载、系统运行时探测或用户自定义路径覆盖。
- 设置页保留只读状态，展示 Node.js、Python、FFmpeg、Chromium 是否读取成功，以及可获得的版本和路径信息。
- 已安装插件、内置插件、插件创建、草稿预览、依赖安装、Agent shell、插件调试与开发工具链中的 Node/Python/FFmpeg/Chromium 调用，全部必须经统一 Resolver 使用软件内置环境。
- 将内置运行时要求、目录布局和发布校验写入 `.trellis/spec/` 的相关规范。

## Acceptance Criteria

- [ ] 在一台未安装 Node.js、Python、FFmpeg、Chrome/Chromium 的干净 Windows x64 环境安装正式产物。
- [ ] 离线状态下，应用能分别执行 `node --version`、`python --version`、`pip --version`、`npm --version`、`ffmpeg -version`。
- [ ] 离线状态下，Node Playwright 和 Python Playwright 插件均能启动安装包内置 Chromium 并完成一个最小页面加载。
- [x] 插件进程解析到的运行时路径均位于应用安装资源或仓库内置目录，不命中宿主全局 `PATH`。
- [ ] 在新电脑仅 clone/checkout 仓库后，不额外下载运行时即可启动桌面开发模式并运行 Node/Python/FFmpeg/Chromium 插件开发 smoke test。
- [x] 插件创建、预览、正式运行、依赖安装和 Agent shell 的运行时路径检查均命中仓库/安装包内置环境。
- [x] 官方 NSIS 和自制 SFX 构建链都强制执行同一运行时文件清单校验。
- [x] 缺少任一必需运行时或校验和不匹配时，构建明确失败。
- [x] 现有运行时解析、插件运行和 Playwright 相关自动化测试通过，并补充内置资源解析测试。
- [x] 项目规范明确记录正式安装包默认内置全部基础运行时。
- [x] 设置页不存在下载、卸载、系统探测和自定义路径操作，且能只读展示四个内置运行时的识别状态。

## Out of Scope

- 在本任务中内置任意插件自己的全部 pip/npm 业务依赖。
- 内置 Firefox、WebKit 或完整 Chrome 产品包。
- 静默修改系统全局 `PATH` 或向系统安装 Node.js/Python。

## Open Questions

- 无。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
