# 设计评审：`--sandbox-soft` 自启动注入持久化防御（P1-9 残余 ②）

- **基线**：`e8edb350` @ `feat/github-import`
- **攻击模型**：未提权的插件在 `Startup` 目录写 `.lnk`、或在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`(及 `RunOnce`/`Wow6432Node`) 写入以 `--sandbox-soft` 拉起宿主自身的条目。宿主下次开机即携带该开关启动，使 `UserInstalled` 插件沙箱失败时从 fail-closed 退化为降级放行（A2 豁免仍属 Medium IL，等于给攻击者常驻逃生通道）。
- **硬约束**：**不得**只依赖 T1 降权（A2 豁免仍为 Medium IL），必须在「自启动播种」这一环就掐断开关被持久化注入的路径。

## 候选方案（≥2）

**方案 A —— 自启动播种检测（推荐，fail-closed）**
进程最早期（`init_argv_snapshot` 内）枚举宿主自身的自启动落点：
1. `HKCU\...\Run` / `RunOnce` / `Wow6432Node` 同名键；
2. 当前用户 `Startup` 目录下的 `.lnk`（按文件内 UTF-16 目标路径 + 命令行启发式识别指向宿主 exe 的条目）。
若任一自启动条目以 `--sandbox-soft` 拉起宿主 → 判定为「被播种的开关」，强制 `SANDBOX_SOFT_SNAPSHOT = false`（忽略该开关），并记录/告警，可选隔离该条目。
- 优点：直接封堵题目给定的攻击面；不依赖降权。手动 `cmd`/资源管理器直启带 `--sandbox-soft` 仍生效（逃生舱保留）。
- 代价：需 Windows 注册表/Startup 枚举（Unix/macOS 该路径无自启动等价，返回 false）。

**方案 B —— 受信启动清单（blessed launch record）**
安装器/管理员工具把「期望的启动命令」（不含 `--sandbox-soft`）写入受保护位置（安装目录下的校验值或 `HKLM` 应用子键，仅安装器可写）。启动时比对实际 argv 与受信记录：若 argv 含 `--sandbox-soft` 但受信记录未授权 → 忽略。
- 优点：与平台无关，不依赖枚举自启动。
- 代价：需安装器配合写入；用户手动加开关的场景需额外白名单，易误伤逃生舱。

**方案 C —— 启动来源判定**
若宿主自身是由自启动机制拉起（父进程/启动原因来自 Run/Startup），则 `--sandbox-soft` 一律不生效；仅交互式/安装器直启才生效。
- 优点：语义直观。
- 代价：准确判定「启动来源」在 Windows 上依赖 WMI/父子进程链，复杂度高、易绕过。

## 选型

采用 **方案 A 为主 + 方案 C 的「自启动来源即忽略开关」作为兜底**：两者都基于「自启动条目是否指向宿主并带 `--sandbox-soft`」这同一个枚举结果，实现合并为单次枚举。手动直启（不在任何自启动条目中）仍正常 honors 开关，保留运维逃生舱。不依赖 T1 降权。

## 反向用例（验收）

- 反向①：在 `HKCU\...\Run` 写入 `<host.exe> --sandbox-soft`，再模拟宿主启动 → `sandbox_soft_enabled()` 返回 `false`（开关被忽略）。
- 反向②：在 `Startup` 目录放一个目标指向宿主且命令行含 `--sandbox-soft` 的 `.lnk`，同上 → `false`。
- 正向（证明非永真）：`cmd` 直接 `<host.exe> --sandbox-soft`（无任何自启动条目指向宿主）→ `true`（逃生舱可用）。

## 实现落点

- `apps/desktop/src-tauri/src/process_util/guarded_spawn.rs`：新增 `#[cfg(windows)]` 枚举函数（参数化以便单测），在 `init_argv_snapshot` 中：若自启动播种为真 → 强制快照 `false`。
- 单测：用注入的自启动条目向量验证反向①/②与正向。

---

## 追加评审：T8 残留边界 —— `cmd /c` 等启动器包装（2026-08-11）

### 现状缺口
原 `autostart_seeds_sandbox_soft` 仅校验 `tokens.first()`（即 `entry[0]` 是否为宿主 exe）。
但攻击者可写 `HKCU\Run` 条目：`cmd /c "C:\Programs\lingfang\lingfang.exe" --sandbox-soft`。
经 `tokenize_cmdline` 拆分后 token 序列为 `[cmd, /c, "C:\...\lingfang.exe" --sandbox-soft]`，
宿主 exe 藏在第三 token 的引号子串内，first-token 为 `cmd` → **旧实现漏检**，逃生开关被持久化注入。

### 加固方案（已实施）
新增纯函数 `unwrap_launcher(tokens)`：当 `tokens[0]` ∈ 已知启动器清单
（`cmd`/`cmd.exe`/`powershell`/`pwsh`/`wscript`/`cscript`/`rundll32` 等）且 `tokens[1]` 为命令开关
（`/c`/`-c`/`/k`/`/command` 等）时，把 `tokens[2..]` 拼回原串后**重新分词**，得到内层真实命令行。
`autostart_seeds_sandbox_soft` 改为：先 `unwrap_launcher`，再扫描内层**所有** token —— 任一 token 经
`norm_exe` 归一后等于/以宿主 exe 结尾、且条目携带 `--sandbox-soft` → 判为播种。

### 取舍与攻击面
- **覆盖**：`cmd /c`、`cmd.exe /c`、`powershell -c/-Command`、`wscript`、`rundll32` 等常见 wrapper 全部解包，封堵题目给定残余边界。
- **误报风险**：仅当「目标疑似宿主 **且** 携带 `--sandbox-soft`」才判播种；`norm_exe` 已做小写/去 `.exe`/去引号归一，
  并以 `ends_with(host)` 兜底短名与相对路径。`notepad.exe`（目标非宿主）即便带开关也不会误判为宿主播种；
  宿主条目不带开关（如 `host.exe --other-flag`）同样不触发。正常第三方自启动不被误伤。
- **保留逃生舱**：手动直启（不在任何自启动条目中）仍由 `sandbox_soft_honored(arg_flag, autostart_seeded)` 正常 honors 开关，与方案 A+C 一致。

### 反向用例（验收，已落单测）
- `autostart_seeds_sandbox_soft_detects_cmd_c_wrapper`：`cmd /c "host.exe --sandbox-soft"` → 断言 `true`（检出）。
- `autostart_seeds_sandbox_soft_detects_powershell_wrapper`：`powershell.exe -c "host.exe --sandbox-soft"` → 断言 `true`。
- 既有 16 用例（含反向①/②与正向直启）全部不回归。

