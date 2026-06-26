# 实施清单：插件 LLM、AI 工作流与 Beta 更新

## 阶段 1：任务启动与基线检查

- [ ] 启动 Trellis 任务：`python3 ./.trellis/scripts/task.py start .trellis/tasks/06-26-plugin-llm-ai-workflow-beta-updates`
- [ ] 记录当前 git 状态。
- [ ] 确认相关规范已读取。

## 阶段 2：插件 LLM 能力收敛

- [ ] 抽出桌面端插件 LLM 调用 helper，HTML 插件继续使用同一路径。
- [ ] 更新 SDK/manifest 可选能力列表，创建器默认把 `llm.chat` 放入 AI 插件能力声明。
- [ ] 迁移内置 notes 插件，移除第三方 LLM 配置和 `net.fetch` 总结实现。
- [ ] 增加单测覆盖 helper 对请求体、错误、返回结构的处理。

## 阶段 3：Node/Python 受控 LLM 桥

- [ ] 新增 Rust 本地 bridge 模块，管理 localhost 地址、token、插件会话上下文。
- [ ] 持久化运行 `start_plugin` 注入 bridge 环境变量。
- [ ] 创建期 `run_plugin_script` 注入 bridge 环境变量。
- [ ] 提供 Node.js/Python 示例调用模板。
- [ ] 覆盖 token 校验、未声明能力、缺登录态、正常 relay 调用的测试或可执行验证。

## 阶段 4：AI 创建器工作流

- [ ] 新增 `check_plugin` 工具。
- [ ] 新增 `review_plugin` 工具。
- [ ] 更新系统提示词，要求生成/修补前后使用检查和 review。
- [ ] UI 展示检查与 review 结果。
- [ ] 补 creator-tools 单测。

## 阶段 5：Beta 更新链路

- [ ] 新增桌面更新通道偏好 helper。
- [ ] 设置页加入 beta 开关，默认关闭。
- [ ] 手动检查更新和启动静默检查使用当前偏好。
- [ ] 后端 release 单测补 STABLE/BETA latest 隔离。
- [ ] 下载页增加 beta 手动查看入口。
- [ ] 发布后台增加通道隔离提示。

## 阶段 6：验证

- [ ] `pnpm -C packages/contract typecheck`
- [ ] `pnpm -C packages/plugin-sdk typecheck`
- [ ] `pnpm -C apps/desktop typecheck`
- [ ] `pnpm -C apps/desktop test`
- [ ] `pnpm -C apps/collab-api test -- --runInBand` 或项目实际测试命令，带 60 秒超时。
- [ ] `cargo test -p lingfang-desktop`
- [ ] 用真实后端完成 HTML/Node/Python 插件 LLM 调用验证。

## 风险文件

- `apps/desktop/src-tauri/src/plugin_runner.rs` 已接近大文件，新增逻辑优先拆入新模块。
- `apps/desktop/src/components/creator/FloatingCreator.tsx` 是大文件，尽量只改提示词和工具注册，复杂 UI 抽小组件。
- `apps/desktop/src/pages/Settings.tsx` 直接承载更新 UI，新增 beta 开关保持简短。