# 桌面客户端

`apps/desktop` 由 React 工作台和 `src-tauri` Rust 壳组成。

## 前端职责

- 登录、团队选择、插件中心、市场、钱包和设置。
- 对话式插件创建器、草稿工作区与发布流程。
- 已安装插件的 iframe/脚本运行界面。
- 本地定时任务页面、常驻执行器和通知协调。

## Rust 壳职责

- 内置运行时解析：Python、Node.js、FFmpeg、Chromium。
- `.lfplugin` v4 检查、安装、更新、激活、回滚和卸载。
- 文件、网络、系统、AI、图片和视频能力桥。
- 插件进程、最小环境、数据目录和日志管理。
- 本地 scheduler 的 cron/once 计算、原子存储、串行执行与历史轮转。

## 插件安装布局

安装账本指向 `installed/<installationId>/releases/<releaseId>/package`。release 目录不可变，共享 `data` 独立存在；更新先进入 pending，启动成功才切换 active。

## 开发验证

```powershell
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop test
pnpm -C apps/desktop vite:build
cargo test -p lingfang-desktop
```

前端 API、SSE 和 Tauri command 的 payload 必须通过共享类型或边界解码器，不在页面中重复猜测字段。
