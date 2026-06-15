# 用 CLI 复刻 AI 换装批量版插件

## Goal

借用源文件 `o:\lingfang-platform\ai换装版本批量版.py` 的业务逻辑（远程 `gpt-image-2` 图像编辑 API、中文 prompt 模板、批量服装×模特笛卡尔积、并发执行 + 重试退避），由 **code-assistant CLI 重新生成全部代码**（Claude 不直接编写换装业务代码），复刻为一个可被 LingFang 桌面壳启动使用的 AI 换装批量版能力。

## 特例授权（CLAUDE.md "记录在案的特例批准"）

- 本任务**代码必须由 code-assistant CLI（claude/codex/opencode）生成**。Claude 负责：需求拆解、prompt 工程（喂给 CLI 的需求描述）、集成进桌面壳、capability 注册、验证。
- 此项偏离 CLAUDE.md "代码主权归 Claude" 总则，经用户明确授权（"必须要用 cli 开发，不能是你开发"）。
- **API key 处理**：用户授权**保留源文件原 key（`sk-sQXtwgZlIFnvR2dvpgnOz7vj1gYhyxqFV6picL8iJk2lFKOO`）作为默认值**。

## 借用的源逻辑（不复制代码，仅作 CLI 需求输入）

- API：`POST http://47.112.8.9:19081/v1/images/edits`，模型 `gpt-image-2`，multipart/form-data 上传图片 + prompt，Bearer key + `X-API-Group` 头（A1/A2/A3/default），返回 `b64_json` 或 URL。
- prompt 模板：CHANGE_CLOTHES / CHANGE_INNER / CHANGE_FACE / MULTI_PERSON_* / FISSION / BATCH_CHANGE_CLOTHES（见源 69-89 行）。
- 批量：服装图区（≤3）× 模特姿态图区（≤20）笛卡尔积，最多 60 任务；并发 20；重试 10 次、指数退避基数 8s；单次超时 180s、总超时 1200s。
- 输出：base64 解码存 PNG（随机名 IMG_XXXXXX.png）。

## Requirements

- R4.1 由 CLI 生成换装核心代码（API 调用、prompt 模板、批量笛卡尔积、并发、重试退避、结果保存），逻辑等价于源文件，代码全新编写。
- R4.2 形态：优先做成**桌面端 builtin python runtime 插件**（`apps/desktop/builtin-plugins/ai-wardrobe/`），manifest.runtime_type=python，UI 由 client 容器承载（图片上传槽 + 模式选择 + 进度 + 结果预览），图像处理通过 python entry 脚本执行。若 CLI 评估更适合作独立 Qt 应用，则插件直接拉起该应用（需能被桌面壳启动）。
- R4.3 默认 API key 保留源文件原值；key 可在插件内/设置覆盖。
- R4.4 单图换装 + 批量换装两条路径都可用。
- R4.5 capability 声明：需 net.fetch（调 API）或自定义 image-edit capability + fs.write（存结果）；按现有 capability 网关注册。
- R4.6 不引入 PyQt5 等重 GUI 依赖（若走内置插件形态，UI 用 HTML/JS，python 仅做图像处理）。

## Acceptance Criteria

- [ ] 换装代码由 CLI 生成（提交记录/过程可追溯）
- [ ] 单图换装：上传模特图 + 服装图 → 生成换装结果图
- [ ] 批量换装：多服装 × 多模特 → 笛卡尔积批量生成
- [ ] 并发 + 重试生效（失败任务有重试，不整体崩溃）
- [ ] 结果图正确保存并可预览
- [ ] 默认 key 保留，可覆盖
- [ ] 可被桌面壳启动/使用（内置插件入口或拉起应用）
- [ ] lint/type-check（前端部分）通过；python 脚本可运行

## Design（CLI 协作模式）

- **Step 1 需求拆解**（Claude）：把上述"借用的源逻辑"整理成结构化需求文档，作为 CLI 的输入 prompt。
- **Step 2 CLI 生成**（Claude 调 code-assistant）：通过 `code_assistant_start_session` + `send_input`（或 codeagent-wrapper）把需求喂给 codex/claude/opencode CLI，要求其生成换装代码（python entry + 可选前端 UI）。
- **Step 3 集成**（Claude）：把 CLI 产出的代码放入 builtin-plugins/ai-wardrobe/，补 manifest.json、capability 注册、桌面壳运行态对接（复用 R3 的脚本运行能力）。
- **Step 4 验证**（Claude）：本地跑通单图 + 批量路径，截图留痕。
- 形态抉择（内置插件 vs Qt 应用）由 Step 2 CLI 评估后定，Claude 在 design.md 补最终决策。

## Implement（执行清单）

1. Claude 整理换装需求文档（prompt 模板、API、批量逻辑、并发参数）。
2. Claude 调 CLI 生成换装代码（记录会话）。
3. Claude 集成进 builtin-plugins + manifest + capability。
4. 本地验证单图/批量，截图留痕。
5. lint/type-check + python 运行验证。

## Files

- `apps/desktop/builtin-plugins/ai-wardrobe/`（新增：manifest.json + entry python + 前端 UI）
- 可能涉及 capability 注册（Rust capability.rs / plugins.rs）

## Notes

- 复杂任务（特例 + CLI 协作）。design 给出协作流程，实现时按 Step 推进。
- 与 R3（Python/Node 启用）协同：换装插件作为 python runtime 插件，其"使用"入口依赖 R3 的脚本运行能力。
- key 保留为用户授权特例，不视作安全违规。
