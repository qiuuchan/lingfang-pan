# 实施计划 — 完整插件开发 SDK 工具链（Child A）

> 关联：`prd.md`、`design.md`、父任务 `07-13-doc-and-sdk-overhaul`
> 执行顺序严格自上而下；每个章节有验证闸门，未通过不进入下一节

## 实施前必备勘察（必须先做，0.5h）

### 0.1 验证 `.lfplugin` v4 内部结构（关键阻塞）

**任务**：精确反推桌面壳 `inspect_artifact` 期望的 zip 内部结构。

**步骤**：

1. 读 `apps/desktop/src-tauri/src/plugin_package_manager.rs` 第 800-1000 行（`install` / `inspect_artifact`）
2. 读 `apps/desktop/src-tauri/src/plugin_store.rs` 中读取 release 目录的代码
3. 在 `apps/desktop/builtin-plugins/` 找一个真实插件，用 `Compress-Archive` 或 `pnpm dlx bestzip` 生成临时 zip，看 `inspect_artifact` 解析报错
4. 在仓库中找已发布的 `.lfplugin` 样本（如有）解压查看

**输出**：在 `.trellis/tasks/07-13-plugin-dev-sdk/research/lfplugin-format.md` 写下：

- zip 内部顶层目录结构（是否含 `manifest.json` 在根，还是 `<id>/manifest.json`）
- 是否需要 `meta.json`，字段是什么
- v4 版本号在 zip 的哪里声明
- entry 文件的相对路径基准

**闸门**：未写出此文档不得开始 §1。

### 0.2 验证 nodejs 插件 ESM 支持

**任务**：确认 `plugin_runner.rs` spawn nodejs 插件时是否 honors `package.json` 的 `type: module`。

**步骤**：

1. 读 `plugin_runner.rs` 中 `ensure_node_dependencies` 与 spawn 节点的代码（约 880-960、1462-1474 行）
2. 看 spawn 命令是否进入插件目录、node 是否自动读 package.json
3. 跑 `apps/desktop/builtin-plugins/game-2048/`（package.json `"type": "commonjs"`，用 require）确认基线
4. 在 `tmp/` 起一个最小 ESM 测试插件（package.json `"type": "module"`，index.js 用 `import`），让桌面壳尝试运行，看是否成功

**输出**：在 `.trellis/tasks/07-13-plugin-dev-sdk/research/nodejs-esm-support.md` 写下结论：

- 模板用 ESM（`import`）还是 CommonJS（`require`）

**闸门**：未写出此文档不得开始 §4.2（nodejs 模板）。

### 0.3 探 `/api/plugin-registry/releases` 真实 schema

**任务**：用 curl 探出 multipart 字段名。

**已完成（bg_4551c121）**：写入 `.trellis/tasks/07-13-plugin-dev-sdk/research/publish-endpoint.md`。

**关键发现（修正 design 假设）**：

- **不是 multipart！** 端点读 `req: Request` 作为 raw `Readable` 流
- 请求体：`.lfplugin` 文件 raw 二进制（`body: fileBuffer`）
- `Content-Type: application/octet-stream`
- 元数据通过自定义 header 传递：`x-plugin-package-id` / `x-plugin-source-kind` / `x-plugin-source-label-b64` / `x-client`
- 权限：`team.plugin.upload` 或 `team.plugin.edit_draft`
- 大小限制：300 MiB
- 响应 201：`{ package, release }`

---

## §1 包骨架与依赖（1h）

### 步骤

- [ ] 1.1 编辑 `packages/plugin-sdk/package.json`：
  - version: `0.0.6` → `0.1.0`
  - 加 `bin`、`exports`、新 `scripts.cli:dev`、`dependencies.jszip`、`devDependencies.tsx`
  - 跑 `pnpm install` 让 workspace 接受新依赖
- [ ] 1.2 创建目录骨架：`src/{manifest,types,cli/{commands,util},templates/{client,nodejs,python}}`
- [ ] 1.3 编辑 `packages/plugin-sdk/tsconfig.json`：确保新目录被 include

### 验证

```bash
pnpm install
pnpm -C packages/plugin-sdk typecheck  # 必须仍然通过（即使新文件还空，也不应破坏现有类型）
pnpm -C packages/plugin-sdk test       # 现有 7 用例继续通过
```

---

## §2 manifest 模块（2h）

### 步骤

- [ ] 2.1 写 `src/manifest/index.ts`：
  - `export type { PluginManifest, CapabilityKind, RuntimeType, PluginCapability } from '@lingfang/contract'`
  - `validateManifest(input: unknown): ManifestResult`
  - 内部：先 `PluginManifest.safeParse(input)` → 若失败转 `ManifestError[]` → 再跑业务规则
- [ ] 2.2 写 `src/manifest/rules.ts`：design.md §3 的 M1-M10 规则，每条独立函数，可单测
- [ ] 2.3 写 `src/manifest/index.spec.ts`：8 个现有插件（用 `import.meta.url` 解析相对路径）逐个跑 `validateManifest` 必须全 success；外加 12+ 个非法用例覆盖每条规则

### 验证

```bash
pnpm -C packages/plugin-sdk test src/manifest
```

8 现有插件全部 success、非法用例全部 failure、覆盖率 ≥ 80%。

---

## §3 types 模块（0.5h）

### 步骤

- [ ] 3.1 写 `src/types/client-entry.ts`（见 design.md §5）
- [ ] 3.2 跑 typecheck 确保全局 Window augment 不与 desktop 的 plugins-runtime.ts 类型冲突

### 验证

```bash
pnpm -C packages/plugin-sdk typecheck
pnpm -r typecheck  # 桌面端不应被新全局污染（除非它显式 import了这个类型）
```

---

## §4 CLI 框架与 create 命令（3h）

### 步骤

- [ ] 4.1 写 `src/cli/index.ts`：dispatch 子命令（无 commander，自写 argv 解析）
- [ ] 4.2 写 `src/cli/parser.ts`：极简参数解析（支持 `--flag value` / `--flag=value` / positional）
- [ ] 4.3 写 `src/cli/log.ts`：`info` / `success` / `warn` / `error` 着色输出（ANSI 转义自写）
- [ ] 4.4 写 `src/cli/util/fs.ts`：跨平台文件操作（拷贝目录树、写文件、确保目录）
- [ ] 4.5 写 `src/cli/util/prompt.ts`：基于 readline 的交互式提示（text / select / multiselect / confirm）
- [ ] 4.6 写 `src/cli/commands/create.ts`：
  - 解析 name / runtime / id / author / description
  - 缺失字段触发交互式
  - 拷贝 `templates/<runtime>/*` 到目标目录，替换模板变量（自写 replace）
  - 末尾打印"下一步"提示
- [ ] 4.7 写 `src/templates/{client,nodejs,python}/manifest.json.tmpl` + 入口文件（按 §0.2 结论决定 nodejs ESM/CJS）
- [ ] 4.8 写 `src/cli/commands/create.spec.ts`：3 runtime 各跑一次、断言生成的 manifest 能 `validateManifest` 成功

### 验证

```bash
pnpm -C packages/plugin-sdk test src/cli/commands/create
pnpm -C packages/plugin-sdk exec lingfang-plugin create tmp-demo --runtime nodejs
pnpm -C packages/plugin-sdk exec lingfang-plugin create tmp-demo-c --runtime client --id com.example.demo
ls tmp-demo/  # 应有 manifest.json + index.js + package.json + README.md
```

清理：`rm -rf tmp-demo tmp-demo-c`

---

## §5 validate 命令（1h）

### 步骤

- [ ] 5.1 写 `src/cli/commands/validate.ts`：
  - 默认 path=`.`，可选 path 参数
  - 跑 manifest 模块的 validateManifest
  - 再加目录结构检查（entry 文件存在）
- [ ] 5.2 写 `src/cli/commands/validate.spec.ts`：合法 / JSON 错 / Zod 错 / 业务规则错 / entry 不存在 共 5+ 用例

### 验证

```bash
# 对 8 个现有插件全部跑 validate
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../plugins/summarizer
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../plugins/ai-demo
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../plugins/videodl
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../apps/desktop/builtin-plugins/ai-example
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../apps/desktop/builtin-plugins/ai-python-example
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../apps/desktop/builtin-plugins/game-2048
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../apps/desktop/builtin-plugins/calculator
pnpm -C packages/plugin-sdk exec lingfang-plugin validate ../../apps/desktop/builtin-plugins/notes
# 全部应退出码 0
```

如果某个插件 validate 失败，**不修改插件**，调整 SDK 校验器（看错误是什么，如果是 SDK 规则过严则放宽；如果是真错误则记录到 `.trellis/tasks/07-13-plugin-dev-sdk/research/existing-plugin-issues.md` 待用户决定）。

---

## §6 build 命令（2h）

### 步骤

- [ ] 6.1 写 `src/cli/util/archive.ts`：用 jszip 创建 zip；按 §0.1 的格式文档打
- [ ] 6.2 写 `src/cli/commands/build.ts`：
  - 先 validate（失败则中止）
  - 收集要打包的文件（manifest.json + entry + 可选 package.json / requirements.txt / ui/ / lib/ / README.md）
  - 排除清单：`node_modules`、`data`、`.git`、`*.log`、`.DS_Store`、`*.lfplugin`
  - 写 `<name>-<version>.lfplugin`
- [ ] 6.3 写 `src/cli/commands/build.spec.ts`：3 runtime 各打包一次，断言 zip 内部结构（用 jszip 解压验证 manifest.json + entry 存在）

### 验证

```bash
pnpm -C packages/plugin-sdk test src/cli/commands/build
# 手动：用 build 命令打 summarizer，然后让桌面壳 install 这个 .lfplugin
pnpm -C packages/plugin-sdk exec lingfang-plugin build ../../plugins/summarizer --out tmp/summarizer.lfplugin
# 在桌面端 UI 试 install 这个文件，看 inspect_artifact 是否成功
```

如果桌面壳 install 失败，看 Rust 端日志，按 §0.1 文档对照修正 archive.ts。

---

## §7 publish 命令（1h）

### 步骤

- [ ] 7.1 写 `src/cli/commands/publish.ts`：
  - 解析 `--base` / `--token` / `--visibility`
  - 调 build 生成临时 `.lfplugin`
  - 用 `fetch` POST `<base>/api/plugin-registry/releases`，multipart 字段名按 §0.3 文档
  - 成功输出 release id；失败输出 HTTP 错误码 + body
- [ ] 7.2 写 `src/cli/commands/publish.spec.ts`：用 vi.stubGlobal stub fetch，覆盖成功 / 401 / 500 三种

### 验证

```bash
pnpm -C packages/plugin-sdk test src/cli/commands/publish
# 手动（需要本地后端 + JWT）：
pnpm -C packages/plugin-sdk exec lingfang-plugin build ../../plugins/summarizer --out tmp/summarizer.lfplugin
pnpm -C packages/plugin-sdk exec lingfang-plugin publish tmp/summarizer.lfplugin --base http://localhost:3000 --token $JWT
```

---

## §8 模板 README 与 .gitignore（0.5h）

### 步骤

- [ ] 8.1 写 `src/templates/{client,nodejs,python}/README.md.tmpl`：含插件简介、能力清单、本地预览方法、发布步骤
- [ ] 8.2 写 `src/templates/{client,nodejs,python}/.gitignore.tmpl`：`data/`、`*.lfplugin`、`node_modules/`、`__pycache__/`、`.venv/`

### 验证

```bash
pnpm -C packages/plugin-sdk exec lingfang-plugin create tmp-readme --runtime nodejs
cat tmp-readme/README.md  # 应有完整中文说明
cat tmp-readme/.gitignore
rm -rf tmp-readme
```

---

## §9 根脚本接入（0.2h）

### 步骤

- [ ] 9.1 编辑根 `package.json`，加 scripts：
  ```json
  "plugin:create": "pnpm -C packages/plugin-sdk exec lingfang-plugin create",
  "plugin:validate": "pnpm -C packages/plugin-sdk exec lingfang-plugin validate",
  "plugin:build": "pnpm -C packages/plugin-sdk exec lingfang-plugin build"
  ```

### 验证

```bash
pnpm plugin:create tmp-root-test
ls tmp-root-test/
rm -rf tmp-root-test
```

---

## §10 整合验证（1h）

### 步骤

- [ ] 10.1 跑全仓 typecheck：`pnpm -r typecheck` 全绿
- [ ] 10.2 跑全仓测试：`pnpm -r test` 全绿
- [ ] 10.3 跑 plugin-sdk 单独测试：`pnpm -C packages/plugin-sdk test --coverage`，覆盖率 ≥ 80%
- [ ] 10.4 手动端到端：
  ```bash
  # 端到端：起一个 client 插件 → validate → build → 桌面壳运行
  pnpm plugin:create e2e-demo --runtime client --id com.example.e2e
  pnpm plugin:validate e2e-demo
  pnpm plugin:build e2e-demo
  cp -r e2e-demo apps/desktop/builtin-plugins/
  pnpm -C apps/desktop dev
  # 在桌面端 UI 找到 e2e-demo，点运行，应正常显示 + 点击按钮能调 llm.chat
  rm -rf e2e-demo apps/desktop/builtin-plugins/e2e-demo
  ```

### 闸门

`pnpm -r typecheck` && `pnpm -r test` 全绿 + 手动端到端通过 → 可进入 Phase 3.3 spec update。

---

## 回退点

- §1 失败：回退 package.json / tsconfig.json 变更
- §6 build 产物桌面壳不认：先确认 §0.1 文档是否准确；若仍失败，回退 build 模块到只生成 manifest + entry 两文件的极简 zip，留待后续修复
- §7 publish 端点字段名错误：先 stub publish（输出"暂未实现，待 endpoint 确认"），不阻塞其他命令

## 预计耗时

| 章节     | 时长                      |
| -------- | ------------------------- |
| §0       | 1.5h                      |
| §1       | 1h                        |
| §2       | 2h                        |
| §3       | 0.5h                      |
| §4       | 3h                        |
| §5       | 1h                        |
| §6       | 2h                        |
| §7       | 1h                        |
| §8       | 0.5h                      |
| §9       | 0.2h                      |
| §10      | 1h                        |
| **合计** | **~13.7h**（约 2 工作日） |

## Review Gates

- Gate 1（§2 完成后）：manifest 校验器对 8 个现有插件全过 → 用户确认校验规则无过严
- Gate 2（§4 完成后）：3 runtime create 输出形态 → 用户确认模板字段顺序与默认值
- Gate 3（§6 完成后）：build 产物被桌面壳接受 → 用户确认 `.lfplugin` 格式正确
- Gate 4（§10 完成后）：全仓绿 + 端到端通过 → 进入 Phase 3.3 spec update

## 不在本计划内（明确出范围）

- 桌面壳热重载 dev 命令集成
- npm publish 到公共 registry（仓库 private）
- cloud runtime 模板
- IDE / VS Code 插件
- Python `lingfang-sdk` pip 包
- 自动覆盖测试覆盖率到 100%（80% 即可）
