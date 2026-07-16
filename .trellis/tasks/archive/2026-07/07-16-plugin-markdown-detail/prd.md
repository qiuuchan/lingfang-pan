# 插件 Markdown 描述页与 SDK 文档

## Goal

为桌面插件中心加入简洁、接近 VS Code Marketplace 的插件详情体验，并把同一套描述文件契约同步到发行版存储、插件 SDK 与开发说明。

## User Value

- 用户在安装或购买前可以阅读结构化的功能说明、使用方式、权限与隐私信息。
- 插件作者只维护一份随发行版冻结的根目录 `README.md`，无需在平台后台重复编辑详情。
- 旧插件没有 README 时仍能正常展示短摘要，不影响兼容性。

## Confirmed Decisions

- `manifest.description` 是列表、搜索和卡片使用的纯文本短摘要。
- 插件根目录大小写精确的 `README.md` 是详情页 Markdown 真源。
- 详情页优先展示当前精确发行版的 README；缺失或为空时回退到 `manifest.description`。
- README 支持安全 GFM；不启用 raw HTML，不执行脚本，不直接渲染插件提供的图片。
- README 必须是 UTF-8，原始文件最大 256 KiB；修改 README 需要发布新版本。
- 用户要求采用推荐方案并保持简单，不再逐项询问。

## Requirements

- 插件制品检查必须读取根目录 `README.md`，拒绝超限或非法 UTF-8，并把内容冻结到对应 release。
- 目录/列表响应不得携带大段 README；只在按精确 release 请求详情时返回 `readme_markdown`。
- 桌面端已安装、团队库和插件市场统一使用同一个详情界面，包含名称、短摘要、版本/runtime/来源等必要元数据和 Markdown 正文。
- 远端详情需要明确的加载、失败和空 README 回退状态；关闭弹窗或切换 release 时不得展示旧请求结果。
- Markdown 链接只允许安全的 HTTP(S) 外链并在独立窗口打开；图片和 raw HTML 不渲染。
- SDK 的 `validate` 与 `build` 在打包前执行与服务端一致的 README 边界校验。
- `create` 的 client、Node.js、Python 模板生成可直接修改的 README，至少包含简介、使用方式、能力与权限、数据与隐私、预览和发布提示。
- SDK README 与插件开发说明记录描述字段、目录结构、限制、CLI 流程、runtime/capability 关系和展示回退规则。

## Out of Scope

- 本任务不实现 Web 插件中心、在线预览、评论、评分、营销素材编辑或富文本后台编辑器。
- 首版不支持 README raw HTML、远程图片、包内相对图片或自定义脚本样式。
- 不把 README 加入插件目录列表响应，也不允许覆盖已发布 release 的 README。

## Acceptance Criteria

- [ ] 含合法根 README 的插件发布后，精确 release 详情返回相同 Markdown；列表响应不返回 README。
- [ ] README 超过 256 KiB 或不是 UTF-8 时，SDK validate/build 与服务端发布均给出稳定错误且不生成/发布制品。
- [ ] 桌面端三类插件来源均可打开统一详情；远端 README 有 loading/error，缺失时回退短摘要。
- [ ] GFM 标题、列表、表格、任务列表、代码块和 HTTP(S) 链接正确显示；raw HTML、图片和危险协议不可执行或展示。
- [ ] 三种 SDK 模板包含 README，相关开发文档能说明从 create、validate、build 到 publish 的完整描述文件流程。
- [ ] contract、collab-api、plugin-sdk、desktop 的相关测试、typecheck/build 通过，且 `git diff --check` 无错误。

## Notes

- 当前工作树已有一套候选实现；本任务以审计、修正和验证为主，保留其他并行插件平台改动。
