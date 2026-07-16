# 插件开发说明

LingFang 采用类似 VS Code Marketplace 的描述方式：`manifest.json` 负责机器可读的运行契约和短摘要，插件根目录的 `README.md` 负责详情页正文。作者只维护这一份 README，平台在发布时把它与发行版一起冻结。

## 1. 创建插件

```bash
lingfang-plugin create
cd <plugin-directory>
```

SDK 目前提供 `client`、`nodejs` 和 `python` 模板。模板会生成 `manifest.json`、对应运行时入口和 README 骨架；README 已包含功能简介、使用方式、能力与权限、数据与隐私、预览和发布章节。

最小目录如下：

```text
my-plugin/
├── manifest.json
├── README.md
└── <entry>
```

## 2. Manifest 与描述

一个最小 manifest 示例：

```json
{
  "id": "com.example.demo",
  "name": "Demo",
  "version": "0.1.0",
  "description": "一句话说明插件解决的问题",
  "runtime_type": "client",
  "entry": "ui/index.html",
  "visibility": "tenant",
  "capabilities": []
}
```

- `description` 是列表、搜索和卡片使用的纯文本短摘要，建议保持单行，最多 4096 个字符。
- `README.md` 是详情页 Markdown 真源，文件名大小写必须精确，且只能位于插件根目录。
- README 可选；旧插件没有 README 时，详情页自动回退到 `description`。
- README 随发行版冻结，不能在线覆盖。修改说明后应提升 `version` 并发布新版本。

## 3. README 展示与安全边界

README 支持常用 GFM：标题、列表、表格、任务列表、代码块和链接。文件按原始字节计算，最大 256 KiB，必须是合法 UTF-8。

详情页不会渲染 raw HTML、脚本、样式、远程图片或包内相对图片。只有完整的 HTTP(S) 外部链接可点击，并在独立窗口打开。因此不要把关键说明只放在图片或 HTML 组件中。

建议至少写清：

- 插件解决的问题和典型使用步骤。
- 输入、输出、失败情况和当前限制。
- 每项能力为什么需要，以及会读取、写入或共享哪些数据。
- 本地预览方式和发布后的验证方式。

## 4. Runtime 与 Capability

`runtime_type` 决定平台怎样启动 `entry`：

| Runtime | 入口与运行方式 |
| --- | --- |
| `client` | HTML 入口，运行在桌面端内嵌页面中 |
| `nodejs` | Node.js 入口，作为独立进程运行 |
| `python` | Python 入口，在插件隔离环境中运行 |
| `cloud` | 由平台云运行环境执行 |
| `workflow` | 由工作流运行时编排一个或多个插件 Action |

插件代码实际调用的能力必须出现在 `manifest.capabilities`。能力声明是平台授权和运行门禁，README 是面向用户的解释，两者不能互相替代。插件不得要求用户填写平台 API Key、模型服务地址、Authorization header 或桥接令牌；AI、文件、网络等访问应通过 SDK 和宿主能力完成。

## 5. 校验、构建与发布

```bash
lingfang-plugin validate
lingfang-plugin build
lingfang-plugin publish
```

`validate` 检查 manifest、runtime/entry、目录结构和 README；`build` 重复同一组门禁后生成标准 `.lfplugin` v4 制品。README 超过 256 KiB 或不是 UTF-8 时，两条命令都会失败，且 `build` 不会生成制品。

不要手工创建 ZIP。标准构建会写入 `_meta.json`、固定制品结构并计算发行版哈希，桌面端和服务端只接受这套格式。

## 6. 平台展示规则

- 已安装、团队库和插件市场共用同一个详情界面。
- 本机安装项读取制品内的 README；团队库和市场打开详情时，按精确 release id 延迟请求正文。
- 插件目录和搜索结果只返回短摘要，不携带 README 大文本。
- README 缺失或为空时显示 `manifest.description`；远端详情加载失败会明确提示，不会显示其他发行版的旧内容。
