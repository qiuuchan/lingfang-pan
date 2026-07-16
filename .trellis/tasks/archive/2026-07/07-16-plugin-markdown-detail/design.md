# 插件 Markdown 描述页与 SDK 文档设计

## Boundaries

- `packages/contract` 定义发行版摘要与发行版详情的差异：只有详情包含 `readme_markdown`。
- `apps/collab-api` 在制品检查阶段提取 README，并在不可变 release 上保存；registry 列表只投影摘要，精确详情单独读取正文。
- `apps/desktop` 对本机安装项读取制品内冻结的 README，对团队库/市场按 release id 延迟获取详情，并统一渲染详情弹窗。
- `packages/plugin-sdk` 在 create/validate/build 阶段生成并校验 README；`docs` 记录面向作者的稳定契约。

## Data Flow

```text
plugin/README.md
  -> SDK validate/build
  -> .lfplugin artifact
  -> collab-api artifact inspection
  -> PluginRelease.readmeMarkdown
  -> GET exact release detail
  -> desktop detail dialog safe Markdown renderer
```

列表卡片只使用 `manifest.description`。打开远端详情后才请求 README，避免目录响应膨胀。已安装插件直接使用本机已解包 release 的 README，不依赖网络。

## Markdown Safety

- 使用现有 React Markdown + GFM 渲染链，不启用 rehype raw HTML。
- 为插件 README 使用专用组件映射：链接只接受 HTTP(S)，增加 `target="_blank"` 与 `rel="noreferrer noopener"`。
- 图片不渲染；HTML 按普通文本/忽略处理；代码块、表格等只产生静态 DOM。
- 服务端和 SDK 都按原始字节限制 256 KiB，并用 fatal UTF-8 decoder 验证。

## Compatibility

- `README.md` 可选；旧制品和旧 release 使用空字符串，并由 UI 回退短摘要。
- 新字段只添加到 release detail contract，不改变现有列表 contract。
- README 与 release 一起冻结，避免详情内容与已审核制品漂移。

## UI Shape

详情弹窗保持单页、少标签：顶部展示插件名称、短摘要和主要操作；正文展示 README；侧边或紧凑元数据区展示版本、runtime、来源、大小/发布时间等可用信息。首版不增加复杂的 Overview/Changelog/Reviews 多标签结构。

## Rollback

若详情正文出现问题，可停止请求/渲染 `readme_markdown` 并回退短摘要；数据库 additive 字段和 SDK 对可选 README 的兼容无需回滚。
