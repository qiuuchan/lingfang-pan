# 运行时

平台契约支持五类运行时：

| 运行时 | 入口 | 执行位置 | 适用场景 |
|---|---|---|---|
| `client` | HTML | 桌面 iframe | 纯前端界面、SDK 能力调用 |
| `nodejs` | JavaScript | 桌面托管进程 | Node 工具、文件处理、本地自动化 |
| `python` | Python | 桌面托管进程 | 图像、视频、数据处理和桌面 UI |
| `cloud` | 平台定义 | 云端执行器 | 可治理的云动作 |
| `workflow` | 工作流定义 | 桌面或云执行器 | 多动作编排 |

`lingfang-plugin create` 当前只生成 `client`、`nodejs`、`python` 三套模板。`cloud` 和 `workflow` 由平台工作流/动作工具链生成，不应伪装成本地脚本模板。

插件进程只获得宿主显式注入的最小环境。不要依赖系统 PATH、用户机器上的 Python/Node 或未声明的网络权限。
