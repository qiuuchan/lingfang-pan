# 修复检查更新失败

## Goal

修复桌面端「检查更新」始终弹「检查更新失败，请重试」通用兜底的问题：当前错误处理把 Tauri 命令抛出的真实失败原因（HTTP 状态、解析失败、网络错误）完全吞掉，用户与开发者都无法看到根因，无从排查。

## Root Cause

调用链：`Settings.checkForUpdate()` → `checkUpdate()` → `tauriInvoke('check_update')` → Rust `check_update` 命令。

Rust 命令签名 `Result<Option<UpdateMetadata>, String>`，失败时 reject 的是**裸字符串**（如「ClaudeCode SDK 返回错误：HTTP 500」「会话已停止」等 `.map_err(|e| e.to_string())` 产物），不是 `Error` 对象，更不是 `ApiError`。

但前端 catch 统一用 `(err as ApiError).message`：

- [Settings.tsx:198](apps/desktop/src/pages/Settings.tsx#L198) `checkForUpdate`：`(err as ApiError).message || '检查更新失败，请重试'`
- [Settings.tsx:233](apps/desktop/src/pages/Settings.tsx#L233) `installUpdate`：`(err as ApiError).message || '下载更新失败，请重试'`

裸字符串没有 `.message` 属性 → 取值恒为 `undefined` → 永远落到 `||` 右侧通用兜底。**真实原因被吞**，无论实际失败是网络不可达、后端 5xx、manifest 解析失败还是验签异常，用户只见同一句文案。

这是 Tauri invoke 的错误约定与前端「假定都是 ApiError」之间的不匹配。`tauriInvoke`（[api.ts:119](apps/desktop/src/lib/api.ts#L119)）直接透传 invoke 的 reject 值，不做归一化。

## Requirements

- 新增统一错误信息提取工具：无论 reject 值是裸字符串、`Error` 实例、`ApiError`（带 `message`），还是其它对象，都能提取出可读信息。
  - 字符串 → 原样返回（trim 后非空）。
  - `Error` / 带 `message` 字段的对象 → 取 `message`。
  - 其它 → 兜底为传入的默认文案。
- 用该工具替换两处更新相关 catch（checkForUpdate / installUpdate），保留各自的默认兜底文案作为最后回退。
- 不改变成功路径行为（返 null → 已是最新；返 meta → 弹 Dialog；事件流不变）。
- 错误提取工具应放在可复用位置（`lib/api.ts` 已是 Tauri/HTTP 错误的公共出入口），供未来其它 Tauri 命令 catch 复用，避免每处各写一遍 `as ApiError`。

## Non-Goals

- 不改 Rust `check_update` / `download_and_install` 的错误文案本身（它们已是中文可读串，问题在前端吞掉了它们）。
- 不处理 release 数据/签名/版本号配置问题：seed 的 0.0.1 < 当前 0.0.2 属正常「无更新」路径，与本 bug 无关；真实签名/产物由平台 Admin 发布时配置，不在本任务范围。
- 不引入新的错误上报/日志体系。

## Acceptance Criteria

- [ ] 新增 `extractErrorMessage(err, fallback)`（或等价命名）工具函数，覆盖字符串 / Error / ApiError / 未知对象四类输入，有单元测试。
- [ ] `checkForUpdate` catch 改用该工具：当 Rust 抛裸字符串（如「ClaudeCode SDK 返回错误：HTTP 500」）时，toast 显示该真实字符串而非通用兜底。
- [ ] `installUpdate` catch 同步改造，行为一致。
- [ ] `pnpm --filter @lingfang/desktop typecheck` 通过。
- [ ] 新增/相关单测通过（`pnpm --filter @lingfang/desktop test`）。

## Notes

- 验证以单元测试为主：构造 `extractErrorMessage('裸字符串', '兜底')` 等用例断言提取结果。端到端真实「检查更新失败」需真实后端异常态，留作手动验证补充。
- 这是「让根因可见」的修复——修好后若仍报错，用户将看到 Rust 抛的具体原因（HTTP 几多/网络/解析），可据此定位是后端发布配置还是网络问题。
