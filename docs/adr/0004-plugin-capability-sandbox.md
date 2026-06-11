# ADR-0004：插件沙箱 = Tauri 2 WebView/iframe + 三重 capability 校验

- **状态**：Accepted
- **日期**：2026-06-09
- **关联**：[插件系统](../02-domain-and-plugins.md)、[ADR-0001](0001-desktop-shell-tauri2.md)

---

## 背景

旧版插件的 `sandbox_mode` 默认是 `none_demo`、`signature_status` 默认是 `unsigned_demo`——沙箱和签名**全是占位字符串**，没有真实隔离。对一个要装第三方代码的平台，这是不可接受的安全空洞。

## 决策

插件运行在**真实沙箱**中，采用「双层隔离 + 三重校验 + 主题统一」：

1. **隔离**：插件 UI 跑在 Tauri 2 受限 WebView 或 `<iframe sandbox>`；默认不开 `allow-same-origin` / 顶层导航；CSP 限制。
2. **零直连**：插件不能 `fetch` / `require` / 直接读文件 / 持有 LLM key；越权操作只能经 `sdk.invoke(capability, args)`。
3. **三重校验**（Rust 核 capability 网关）：
   - Tauri 2 capability 文件是否允许该能力；
   - 插件 `manifest.capabilities` 是否声明；
   - 当前用户是否被 `PluginGrant` 授权、高风险能力是否经管理员批准。
4. **主题统一**：插件 CSS 只能消费宿主 design token，禁止硬编码色值。

## 理由

- 插件作者来自不同租户、代码不可信，必须强隔离。
- Tauri 2 capability 原生支持「按能力授权」，三重校验把「平台规则 / 插件声明 / 用户授权」分层，职责清晰。
- 主题 token 化保证「装 N 个插件还像同一个 App」，兑现极简承诺。

## 取舍 / 代价

- WebView/iframe 比「裸挂 DOM」启动稍慢、通信要走 bridge——换来的是安全与稳定，值得。
- 市场级**代码签名**首发不做（纯团队内，Q3），但保留 `signature` 概念位，M5 市场阶段再启用真实签名。

## 后果

- 能力清单（含 `system.screenshot` 等）统一映射到 Tauri 2 capability/permission。
- 旧版的 `none_demo` / `unsigned_demo` 占位状态被真实模型取代。
