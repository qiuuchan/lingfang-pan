# ADR-0001：桌面壳采用 Tauri 2 + Rust

- **状态**：Accepted
- **日期**：2026-06-09
- **关联**：[架构总览](../01-vision-and-architecture.md)、[插件系统](../02-domain-and-plugins.md)

---

## 背景

旧版项目的体检发现一处严重的、程序不正当的选型问题：

- 原始需求资料白纸黑字写「**桌面壳必须 Tauri，不能 Electron**」，理由是 Tauri 的 capability 机制天然适配「插件申请权限 + 管理员批准」，而「Electron 这块是裸奔的」。
- 产品愿景把「桌面壳技术栈」列为**待拍板**问题。
- 但旧版的 ADR 自身状态还是「Proposed」，却已既成事实地全量用了 Electron，并为此**自造一层 Capability Bundle 抽象（自承认 +2 周工时）**去补 Electron 缺失的权限模型。

即：用开发便利性（Node 生态、隔离现成）推翻了基于安全的硬约束，且花两周造了 Tauri 原生白送的轮子。

## 决策

**新平台桌面壳采用 Tauri 2 + Rust。** 插件 UI 用 Web 技术（HTML/JS/CSS）跑在受限 WebView / iframe 中，越权能力经 Rust 核的 capability 网关。

## 理由

1. **capability/permission 原生**：Tauri 2 的能力系统正是本平台插件沙箱的核心诉求——「插件 X 申请 Y 权限，管理员是否同意」原生可表达，无需自造。
2. **符合原始硬约束**：尊重需求源头「必须 Tauri」的决定。
3. **体积与安全**：~10MB 量级，攻击面比 Electron 小，安全模型现代。
4. **系统能力可达**：文档/知识场景需要的读文件、截屏等系统能力，通过 Tauri plugin 生态 + capability 授权即可，正好兑现 [03 插件系统](../02-domain-and-plugins.md) 里 `system.screenshot` 这类能力。

## 取舍 / 代价

- **Rust 门槛**：核与（可能的）服务端需要 Rust 能力。缓解：插件作者完全不碰 Rust（写 Web + 用 TS SDK）；平台核心团队承担 Rust。
- **Node 生态在壳内受限**：但插件本就是 Web 沙箱，不需要 Node；确需 Node 生态的「云插件」走服务端 `runtime_type: 'cloud'`（后置）。
- **WebView 跨平台差异**：首发只做 Windows（见非目标），差异面可控。

## 后果

- 插件 SDK 仍是 TypeScript（`@lingfang/plugin-sdk`），作者体验不受 Rust 影响。
- 旧版自造的 Capability Bundle 抽象**不再需要**——用 Tauri 2 原生能力替代。

## 为什么旧版选 Electron 的理由不成立（存档对照）

| 旧版给的 Electron 理由 | 评判 |
|----------------------|------|
| Node 生态、作者门槛低 | 插件是 Web 沙箱，作者不碰 Node；理由错位 |
| 多进程隔离现成 | Tauri 2 同样有 WebView 隔离 + 原生 capability，更契合插件场景 |
| 跨端渲染一致 | 首发仅 Windows，差异不构成阻塞 |
| 回避了「必须 Tauri / 权限裸奔」的硬约束 | 这才是关键，旧版未正面回应 |
