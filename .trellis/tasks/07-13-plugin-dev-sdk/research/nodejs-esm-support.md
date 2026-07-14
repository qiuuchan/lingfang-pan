# Node.js 插件 ESM 支持研究

> 调研时间：2026-07-14
> 任务：.trellis/tasks/07-13-plugin-dev-sdk
> 驱动决策：templates/nodejs/index.js.tmpl 使用 ESM（import）还是 CommonJS（require）

## Question

桌面壳 plugin_runner.rs spawn Node.js 插件时，是否 honors package.json 的 type=module 字段？Node.js 插件模板能否使用 ESM import 语法？

## Code Analysis

### 1. 入口 spawn 流程（持久化运行 start_plugin）

文件：apps/desktop/src-tauri/src/plugin_runner.rs

Node.js 分支（第 1452-1486 行）：
- 判断依据：manifest.entry（约定为 index.js）
- 两条路径：
  - 有 scripts.start（第 1475 行）：pnpm start（或 npm start 回退）
  - 无 scripts.start（第 1483 行）：node <entry_abs>（裸 node 直跑）

spawn 调用（第 1568-1576 行）：
`
let mut command = std::process::Command::new(&binary);
command.current_dir(&plugin_dir).args(&args).env_clear().envs(env);
`

### 2. 预览试跑流程（run_plugin_script）

文件：apps/desktop/src-tauri/src/plugin_script.rs

流程（第 441-611 行）：
1. materialize_sandbox：把所有文件写到临时沙箱目录（含 package.json + index.js）
2. ensure_node_dependencies：在沙箱目录安装依赖
3. run_capture_with_env：运行 node <entry_canon>，cwd=沙箱目录

### 3. 环境变量注入

minimal_env（plugin_runner.rs 第 822-838 行）：
PATH, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot, TEMP, TMP, LANG, LC_ALL

runtime.env（runtime_resolver.rs 第 247-279 行）：替换 PATH 为内置运行时路径，追加 npm/pip 镜像源。

### 4. 内置插件现状

| 插件 | package.json | type 字段 | 模块语法 |
|------|-------------|-----------|---------|
| game-2048 | 有 | commonjs | require() |
| ai-demo | 无 | N/A | require() |
| ai-example | 无 | N/A | - |
| calculator | 无 | N/A | - |
| notes | 无 | N/A | - |

全部内置插件均使用 CommonJS。暂无 ESM 先例。

## Node.js ESM 决议机制

Node.js 从入口文件所在目录开始向上查找 package.json，不是从 cwd。

入口 <plugin_dir>/index.js 所在目录就是 <plugin_dir>/，该目录包含 package.json（AI 创建器强制要求）。Node.js 将读取该 package.json 的 type 字段。

## 结论

ESM 判定：完全支持

### 模板决策

- package.json.tmpl 应包含 type=module
- index.js.tmpl 应使用 import 语法

### Edge Cases / Caveats

- 无 package.json 的插件：AI 创建器强制 nodejs 插件必须含 package.json，此情况不会发生
- 模板使用顶层 await（design.md 第 313-365 行）：ESM 支持顶层 await（Node 14.8+），内置 Node >= 20 完全支持
- 现有内置插件不受影响：game-2048 声明 type=commonjs 将继续以 CJS 处理
