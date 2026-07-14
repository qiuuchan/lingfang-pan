# 技术设计 — 完整插件开发 SDK 工具链（Child A）

> 真源：`bg_29d37e4e` 运行时勘探 + `bg_8ff02d63` 插件清单 + 既有源码

## 1. 包布局

**单包多入口**（不拆新包，扩展 `packages/plugin-sdk`）：

```
packages/plugin-sdk/
├── src/
│   ├── index.ts               # 运行时客户端（逐字不变，向后兼容）
│   ├── index.spec.ts          # 既有测试（不动）
│   │
│   ├── manifest/
│   │   ├── index.ts           # 透传类型 + validateManifest + 结构校验
│   │   ├── rules.ts           # 业务规则：entry 扩展名 / id 命名 / runtime-entry 匹配
│   │   └── index.spec.ts      # 含 8 个现有插件的快照测试
│   │
│   ├── types/
│   │   └── client-entry.ts    # ClientPluginEntry 类型（描述 window.sdk）
│   │
│   ├── cli/
│   │   ├── index.ts           # bin 入口，dispatch 子命令
│   │   ├── parser.ts          # 极简参数解析（无 commander/yargs，省依赖）
│   │   ├── log.ts             # 中文输出（成功/警告/错误着色）
│   │   ├── commands/
│   │   │   ├── create.ts      # 交互式 + 一行式新建工程
│   │   │   ├── validate.ts    # 校验
│   │   │   ├── build.ts       # 打包 .lfplugin
│   │   │   └── publish.ts     # 上传 plugin-registry
│   │   └── util/
│   │       ├── fs.ts          # 文件操作（跨平台 path 处理）
│   │       ├── prompt.ts      # 交互式提示（readline）
│   │       └── archive.ts     # zip 打包
│   │
│   └── templates/
│       ├── client/            # client 模板源文件
│       │   ├── manifest.json.tmpl
│       │   ├── ui/
│       │   │   └── index.html.tmpl
│       │   ├── README.md.tmpl
│       │   └── .gitignore.tmpl
│       ├── nodejs/
│       │   ├── manifest.json.tmpl
│       │   ├── index.js.tmpl
│       │   ├── package.json.tmpl
│       │   ├── README.md.tmpl
│       │   └── .gitignore.tmpl
│       └── python/
│           ├── manifest.json.tmpl
│           ├── main.py.tmpl
│           ├── requirements.txt.tmpl
│           ├── README.md.tmpl
│           └── .gitignore.tmpl
│
└── package.json               # 加 bin + exports + 新依赖
```

### package.json 变更

```jsonc
{
  "name": "@lingfang/plugin-sdk",
  "version": "0.1.0",  // minor bump：新增功能，向后兼容
  "type": "module",
  "main": "src/index.ts",          // 不变：workspace 消费的 TS 入口
  "bin": {
    "lingfang-plugin": "src/cli/index.ts"  // tsx-style，由 consumer 编译
  },
  "exports": {
    ".": "./src/index.ts",
    "./manifest": "./src/manifest/index.ts",
    "./types/client-entry": "./src/types/client-entry.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "cli:dev": "tsx src/cli/index.ts"  // 本地开发用
  },
  "dependencies": {
    "@lingfang/contract": "workspace:*",
    "jszip": "^3.10.1"  // 唯一新增运行时依赖（用于 .lfplugin 打包）
  },
  "devDependencies": {
    "typescript": "^5",
    "vitest": "^4.1.8",
    "tsx": "^4"
  }
}
```

**为什么单包不拆**：
- 主题一致（都为"插件作者服务"）
- 一条 `pnpm add @lingfang/plugin-sdk` 拿全
- workspace 内消费简单（contract ↔ sdk 一次性安装）
- 模板复用 manifest 类型定义

**为什么用 `jszip` 不用 Node 标准 `zlib`**：
- `.lfplugin` v4 是 zip 结构（不是 tar.gz 或纯 zlib）。`zlib` 不能直接做 zip 容器
- `jszip` 是 npm 上 zip 库事实标准，纯 JS、零原生依赖、3M 月下载
- 替代方案 `adm-zip` 也可，但社区活跃度低；`yazl`/`yauzl` 太底层

## 2. CLI 命令规格

### 2.1 `lingfang-plugin create [name]`

**用法**：
```bash
lingfang-plugin create my-plugin                    # 交互式
lingfang-plugin create my-plugin --runtime nodejs   # 一行式
lingfang-plugin create my-plugin --runtime client --id com.example.my-plugin --author "Your Name"
```

**交互式流程**（无参数或部分参数缺失时）：
1. 插件显示名（默认取 name）
2. id（默认根据 name 推导：`com.author.<kebab-name>`，author 默认从 git config.user.name 取，否则 `example`）
3. version（默认 `0.1.0`）
4. description（可空）
5. runtime（多选 1：client / nodejs / python，带说明）
6. 是否声明能力（多选：ui.view / fs.read / fs.write / fs.pick / llm.chat / image.generate / clipboard / storage.kv / system.info / system.notify / net.fetch；每选一个追加 reason 输入）

**输出**：在 `<cwd>/<name>/` 下生成完整工程，最后打印：
```
✓ 已创建插件：./my-plugin
  下一步：
    cd my-plugin
    lingfang-plugin validate
    lingfang-plugin build
```

### 2.2 `lingfang-plugin validate [path]`

**默认 path**：当前目录

**校验层次**：
1. **JSON 语法**：`manifest.json` 能被 `JSON.parse`
2. **Zod schema**：`PluginManifest.parse(input)` 通过
3. **业务规则**（见 §3）
4. **目录结构**：`entry` 字段指向的文件真实存在
5. **runtime 特定文件**：
   - `nodejs`：若 `entry` 是 `index.js` 且存在 `package.json`，校验 `package.json` 可解析
   - `python`：若 `requirements.txt` 存在，校验可解析（pip 格式宽松校验）

**退出码**：0=成功，1=校验失败

**输出格式**：
```
✓ manifest.json 语法正确
✓ Zod schema 校验通过
✓ entry 文件 ui/index.html 存在
✓ 4 个能力声明全部合法
✓ id 格式合法（com.example.my-plugin）

校验通过：my-plugin v0.1.0
```

或失败：
```
✗ manifest.json 第 3 行：JSON 语法错误
  > Unexpected token } in JSON at position 42

✗ Zod schema：version 必须是语义版本号（X.Y.Z）
  > 收到：0.1

校验失败：2 个错误
```

### 2.3 `lingfang-plugin build [path] [--out <file>]`

**默认 out**：`<pluginName>-<version>.lfplugin`

**打包逻辑**（基于 `plugin_package_manager.rs::inspect_artifact` 反推的 v4 格式）：
1. 先跑 `validate`，失败则中止
2. 创建 zip：
   ```
   <pluginId>-<version>.lfplugin (zip)
   ├── manifest.json        # 直接拷贝
   ├── <entry file>         # 直接拷贝（如 ui/index.html 或 index.js 或 main.py）
   ├── package.json         # 若存在
   ├── requirements.txt     # 若存在
   ├── ui/                  # client runtime 的整个 ui/ 目录
   ├── lib/                 # 若有辅助模块目录
   └── README.md            # 若存在
   ```
3. 不打包：`node_modules/`、`data/`、`.git/`、`*.log`、`.DS_Store`、`.lfplugin`（避免递归）

**`.lfplugin` 格式来源**：实施时**第一件事**就是读 `apps/desktop/src-tauri/src/plugin_package_manager.rs` 第 849-960 行的 `inspect_artifact`，把 zip 内部结构、是否需要 meta.json、版本号字段名（v4 含义）逐字反推。**不许猜**。

### 2.4 `lingfang-plugin publish [path] --base <url> --token <jwt> [--package-id <id>] [--source-kind <kind>] [--source-label <text>]`

**逻辑**（**调研后修正**：不是 multipart，是 raw binary stream）：
1. 先 `build` 生成临时 `.lfplugin`
2. `POST <base>/api/plugin-registry/releases`：
   - 请求体：raw 二进制（`body: fileBuffer`，**不是 FormData**）
   - `Content-Type: application/octet-stream`
   - `Authorization: Bearer <jwt>`
   - 可选自定义 header（按 `.trellis/tasks/07-13-plugin-dev-sdk/research/publish-endpoint.md`）：
     - `x-plugin-package-id`：发布到现有 package
     - `x-plugin-source-kind`：来源类型枚举
     - `x-plugin-source-label-b64`：base64url 编码的 UTF-8 标签
     - `x-client: desktop`：使用 DESKTOP 摄取通道
3. 期望 201 响应：`{ package: {...}, release: {...} }`

**重要**：
- 不调用 `sdk.plugin.upload()`——它在运行时直接抛错（`plugins-runtime.ts:344` "运行中的插件不能发布制品"）。改用直接 HTTP 调 plugin-registry 端点（已勘探确认存在且工作）。
- 端点权限：JWT 必须有 `team.plugin.upload` 或 `team.plugin.edit_draft`。
- 大小限制：300 MiB（`PLUGIN_ARTIFACT_MAX_BYTES`）。

**退出码**：0=成功，1=网络/认证失败

### 2.5 不实现 `dev` 命令的桌面集成

v1 仅在 `lingfang-plugin validate` 后输出一段"本地预览"提示：

```
本地预览方法：
  1. 把插件目录复制到 apps/desktop/builtin-plugins/<name>/
  2. 重启桌面端 dev：pnpm -C apps/desktop dev
  3. 桌面端"插件"页可见该插件，点"运行"测试
```

不实现自动复制 / 监听 / 热重载。理由：桌面壳的 `load_builtin_plugins_from_dirs` 在启动时一次性扫描，热重载涉及 Tauri 状态重置，复杂度过高且非本任务范围。

## 3. manifest 校验规则（`packages/plugin-sdk/src/manifest/rules.ts`）

Zod `PluginManifest` 通过后，再跑下列业务规则（每条违反生成一个 `ManifestError`）：

| 编号 | 规则 | 错误码 |
|------|------|--------|
| M1 | `id` 不为空，且匹配 `^[a-zA-Z][a-zA-Z0-9-_.]*$`（允许反向域名 `com.foo.bar` 与点式 `builtin.x`，不允许纯数字开头） | `invalid_id` |
| M2 | `version` 必须是有效 semver（由 `StrictSemVer` 保证，但额外禁止 `0.0.0` 与 `0.0.0-xxx` 起步） | `invalid_version` |
| M3 | `runtime_type === 'client'` 时 `entry` 必须以 `.html` 结尾 | `entry_runtime_mismatch` |
| M4 | `runtime_type === 'nodejs'` 时 `entry` 必须以 `.js`/`.mjs`/`.cjs` 结尾 | `entry_runtime_mismatch` |
| M5 | `runtime_type === 'python'` 时 `entry` 必须以 `.py` 结尾 | `entry_runtime_mismatch` |
| M6 | `runtime_type === 'cloud'` 时 `entry` 必须是 URL（`https?://`） | `entry_runtime_mismatch` |
| M7 | `capabilities[].kind` 必须在 `CapabilityKind` 枚举中（Zod 已保证，但再校验一次防止 contract 漂移） | `unknown_capability` |
| M8 | `capabilities[].reason` 当 risk ≥ medium 时不应为空（提醒作者写清楚为什么需要这个能力） | `missing_reason` |
| M9 | `capabilities` 不允许重复声明同一 `kind`（去重） | `duplicate_capability` |
| M10 | `entry` 文件路径不包含 `..` / 不绝对（防路径逃逸） | `unsafe_entry_path` |

`validateManifest` 返回：
```ts
type ManifestError = { code: string; path: string; message: string };
type ManifestResult =
  | { success: true; manifest: PluginManifest }
  | { success: false; errors: ManifestError[] };
```

## 4. 模板规格

3 套模板，统一字段顺序（id, name, version, description, runtime_type, entry, visibility, capabilities）。**模板字段顺序规范化是文档明示契约**——既有 8 个插件字段顺序不一致（videodl 把 visibility 放在 capabilities 之后），模板只学其正确字段，不学其顺序混乱。

### 4.1 client 模板（`templates/client/`）

**manifest.json.tmpl**：
```json
{
  "id": "{{id}}",
  "name": "{{name}}",
  "version": "{{version}}",
  "description": "{{description}}",
  "runtime_type": "client",
  "entry": "ui/index.html",
  "visibility": "{{visibility}}",
  "capabilities": [
    {{#each capabilities}}
    { "kind": "{{this.kind}}", "reason": "{{this.reason}}", "risk": "{{this.risk}}", "requires_admin": false }{{#unless @last}},{{/unless}}
    {{/each}}
  ]
}
```

（实际实现用极简 string.replace 或自带模板函数，**不引入 handlebars**——理由：模板变量少，依赖过重）

**ui/index.html.tmpl**：
```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>{{name}}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: system-ui, sans-serif;
      margin: 24px;
      background: var(--lf-bg, #fff);
      color: var(--lf-fg, #111);
    }
    button { padding: 8px 16px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>{{name}}</h1>
  <p>{{description}}</p>
  <button id="btn">点击调用 llm.chat</button>
  <pre id="out"></pre>
  <script>
    // client 插件：window.sdk 由宿主在 iframe 加载前注入。
    // TS 用户可：import type { ClientPluginEntry } from '@lingfang/plugin-sdk/types/client-entry'
    //          然后声明：declare const sdk: ClientPluginEntry
    /** @type {any} */
    const sdk = window.sdk;
    document.getElementById('btn').addEventListener('click', async () => {
      if (!sdk?.llm?.chat) {
        document.getElementById('out').textContent = '当前运行环境未注入 sdk.llm.chat';
        return;
      }
      const reply = await sdk.llm.chat({
        messages: [{ role: 'user', content: '你好，请用一句话介绍 LingFang 平台。' }],
      });
      document.getElementById('out').textContent = reply;
    });
  </script>
</body>
</html>
```

### 4.2 nodejs 模板（`templates/nodejs/`）

**manifest.json.tmpl**：runtime_type="nodejs", entry="index.js"

**index.js.tmpl**：
```js
// {{name}} — Node.js 脚本插件
// 通过 @lingfang/plugin-sdk 调用平台能力（推荐，比手写 fetch 桥客户端干净）
import { sdk, PluginAiError } from '@lingfang/plugin-sdk';

const http = await import('node:http');

const server = http.createServer(async (req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>{{name}}</title>
      <h1>{{name}}</h1><p>{{description}}</p>
      <button onclick="test()">调用 llm.chat</button>
      <pre id="o"></pre>
      <script>
        async function test() {
          const r = await fetch('/api/llm');
          document.getElementById('o').textContent = await r.text();
        }
      </script>`);
    return;
  }
  if (req.url === '/api/llm' && req.method === 'GET') {
    try {
      const reply = await sdk.llm.chat({
        messages: [{ role: 'user', content: '你好，请用一句话介绍 {{name}} 插件。' }],
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(reply);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof PluginAiError ? `[${err.code}] ${err.message}` : String(err));
    }
    return;
  }
  res.statusCode = 404;
  res.end('Not Found');
});

// 端口自发现（41984-42084）
const PORT_BASE = 41984;
for (let port = PORT_BASE; port < PORT_BASE + 100; port++) {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    console.log(`[{{name}}] 服务已启动：http://127.0.0.1:${port}`);
    break;
  } catch { /* try next */ }
}
```

**package.json.tmpl**：
```json
{
  "name": "{{id}}",
  "version": "{{version}}",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lingfang/plugin-sdk": "*"
  }
}
```

注意：模板里 `@lingfang/plugin-sdk": "*"` 是占位，作者自行替换为 workspace 或具体版本。**模板生成时不联网下载依赖**，由桌面壳的 `pnpm install` 阶段处理。

### 4.3 python 模板（`templates/python/`）

**manifest.json.tmpl**：runtime_type="python", entry="main.py"

**main.py.tmpl**（纯标准库 http.server，与 ai-python-example 风格一致）：
```python
"""{{name}} — Python 脚本插件"""
import http.server
import json
import os
import threading
import urllib.request
import webbrowser

BRIDGE_URL = os.environ.get("LINGFANG_PLUGIN_BRIDGE_URL", "")
BRIDGE_TOKEN = os.environ.get("LINGFANG_PLUGIN_BRIDGE_TOKEN", "")


def call_bridge(path: str, payload: dict) -> dict:
    """调用平台本地桥。"""
    if not BRIDGE_URL or not BRIDGE_TOKEN:
        raise RuntimeError("桥未注入：请在 LingFang 桌面壳内运行此插件")
    req = urllib.request.Request(
        f"{BRIDGE_URL}{path}",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "X-LingFang-Plugin-Token": BRIDGE_TOKEN,
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def llm_chat(content: str, model: str = "fast") -> str:
    return call_bridge("/llm/chat", {"messages": [{"role": "user", "content": content}], "model": model}).get("content", "")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                f"""<!doctype html><meta charset="utf-8"><title>{{name}}</title>
                <h1>{{name}}</h1><p>{{description}}</p>
                <button onclick="test()">调用 llm.chat</button>
                <pre id="o"></pre>
                <script>
                async function test() {{
                    const r = await fetch('/api/llm');
                    document.getElementById('o').textContent = await r.text();
                }}
                </script>""".encode()
            )
            return
        if self.path == "/api/llm":
            try:
                reply = llm_chat("你好，请用一句话介绍 {{name}} 插件。")
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(reply.encode())
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


def find_port():
    for port in range(41984, 42084):
        try:
            http.server.HTTPServer(("127.0.0.1", port), Handler)
            return port
        except OSError:
            continue
    raise RuntimeError("no available port")


if __name__ == "__main__":
    port = find_port()
    print(f"[{{name}}] 服务已启动：http://127.0.0.1:{port}")
    threading.Thread(target=lambda: webbrowser.open(f"http://127.0.0.1:{port}"), daemon=True).start()
    http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
```

注意：python 模板用**纯标准库**调桥（不依赖 Python `lingfang-sdk` 包），与 ai-python-example 一致——因为 Python 生态没有 `@lingfang/plugin-sdk` 对等包（出范围 N4）。

**requirements.txt.tmpl**：空文件（仅标准库），但保留以便用户加依赖。

## 5. ClientPluginEntry 类型

`src/types/client-entry.ts`：

```ts
import type { sdk } from '../index';

/**
 * client runtime 插件的宿主注入全局。
 * 桌面壳在 iframe srcDoc 注入 `window.sdk`，结构与 @lingfang/plugin-sdk 导出的 sdk 一致。
 * TS 用户用法：
 *   import type { ClientPluginEntry } from '@lingfang/plugin-sdk/types/client-entry';
 *   declare const sdk: ClientPluginEntry;
 *   await sdk.llm.chat({ messages: [...] });
 */
export type ClientPluginEntry = typeof sdk;

declare global {
  interface Window {
    sdk?: ClientPluginEntry;
    __lingfangInvoke?: (capability: string, args: unknown) => Promise<unknown>;
  }
}
```

让 TS client 插件作者写 `declare const sdk: ClientPluginEntry` 时拿到与 npm 包完全一致的类型补全。**不增加运行时代码**，只是类型重导出。

## 6. 依赖论证

| 依赖 | 用途 | 必要性 | 替代方案 | 决定 |
|------|------|--------|---------|------|
| `jszip` | build 命令打 zip | 必要（`.lfplugin` 是 zip） | `adm-zip` / `yazl+yauzl` / 自己写 | **保留 jszip**：事实标准，纯 JS，活跃维护 |
| `tsx` (dev) | CLI 本地开发用 tsx 跑 TS | 仅 dev | `ts-node` / 自带 `--loader ts-node/esm` | **保留 tsx**：现代、ESM 友好 |
| `commander` / `yargs` | CLI 参数解析 | **不要** | 自写 60 行 parser | **不用**：CLI 命令少（4 个），自写更轻 |
| `inquirer` / `prompts` | 交互式提示 | **不要** | Node.js readline | **不用**：readline 已够用，避免额外依赖 |
| `chalk` / `kolorist` | 终端着色 | **不要** | ANSI 转义自写 | **不用**：3 行函数搞定 |
| `handlebars` | 模板变量替换 | **不要** | 自写 string.replace | **不用**：模板变量少 |

**最终新增运行时依赖：`jszip` 一个**。

## 7. 跨平台兼容

- 路径处理：`path.posix.join` 用于 manifest 内部（始终 `/`），`path.join` 用于文件系统操作（OS 决定）
- `.lfplugin` zip 内部一律 `/` 分隔（zip 标准）
- 不调用任何 shell 命令（`spawn`/`exec`）——纯 Node.js API
- Windows 路径输入接受 `\` 或 `/`，内部规范化

## 8. 向后兼容证据

实施时**逐字保留**：
- `packages/plugin-sdk/src/index.ts` 第 1-292 行的所有 `export`（`sdk`、`PluginAiError`、`PluginAiErrorInit`、所有 type 别名）
- `packages/plugin-sdk/src/index.spec.ts` 的 7 个测试用例全部继续通过
- `package.json` 的 `main`、`type`、现有 `scripts.typecheck`、`scripts.test`
- `tsconfig.json`

**新增**：exports、bin、新依赖、新文件。

实施完成后跑 `pnpm -C packages/plugin-sdk test` 必须显示原有 7 个用例 + 新增用例全绿。

## 9. 测试策略

- `src/manifest/index.spec.ts`：8 个现有插件 + 模板生成的插件 + 各类非法输入（共 ≥ 20 用例）
- `src/cli/commands/create.spec.ts`：交互式 + 一行式 + 各 runtime（共 ≥ 6 用例）
- `src/cli/commands/validate.spec.ts`：合法 / JSON 错 / Zod 错 / 业务规则错（共 ≥ 8 用例）
- `src/cli/commands/build.spec.ts`：3 runtime 各打包一次 + zip 内部结构断言（共 ≥ 4 用例）
- `src/cli/commands/publish.spec.ts`：用 mock fetch 测试，不打真实网络（共 ≥ 3 用例）

## 10. 兼容性回退

如果实施中发现某条 Zod 规则改动会破坏现有 8 个插件中任何一个的 validate，**必须**调整 SDK 校验器（放宽），而不是改 contract 或改插件。具体调整在 implement.md 中说明。

## 11. 关键风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| `.lfplugin` v4 格式反推错误 → build 产物桌面壳不认 | 中 | 高 | 实施第一步必须读 Rust 源码 + 用真实 `.lfplugin`（如有）反向解压对照 |
| `publish` 端点要求 multipart 字段名未知 | 中 | 中 | 实施时用 `curl` 先打一次 `/api/plugin-registry/releases` 探字段名 |
| 现有 8 个插件中某些 manifest 字段顺序混乱导致 Zod schema 严格化时失败 | 低 | 中 | Zod schema 不关心字段顺序；只关心结构。已确认 8 个现有插件均通过 schema 校验 |
| nodejs 模板用 `import { sdk }` ESM，但桌面壳 spawn 用 `node index.js`（CommonJS）失败 | 高 | 高 | **必须**先验证 `plugin_runner.rs` 启动 nodejs 插件时是否 honors `package.json.type=module`。如果不 honors，模板必须改回 CommonJS（`require`）。这是 implement.md 第 0 步验证项。 |
