// plugin-status.ts — 插件持久化目录 + 动态状态 + 进程运行的 Tauri 命令封装。
//
// 背景（task 06-16-plugin-system-rebuild 组C）：
// 旧架构：CLI 生成插件写入临时 sandbox（app_data/claude-sandbox/），插件状态硬编码进 PluginDraft.status。
// 新架构：插件文件持久化在 plugins_root/plugin_id/（默认 app_data/plugins/，设置页可配置），
//         状态从文件系统实时扫描判定（ready/incomplete/error/running/stopped），
//         Python 用 .venv 隔离运行、Node 用 pnpm install+start，作为独立进程运行（外部窗口/终端）。
//
// 本文件封装组A/组B Rust 后端暴露的命令契约，供前端组件复用：
//   - scan_plugin_status：扫描 plugins_root 子目录，返回每个插件的动态状态。
//   - start_plugin / stop_plugin：启动/停止 Python/Node 插件独立进程。
//   - get_plugins_root / set_plugins_root：插件存放路径读取/配置。
//
// 注：这些 Rust 命令由组A（目录管理）/组B（venv+pnpm 运行）实现，本封装层按契约先行落地，
// 后端实现后即生效；命令未实现时 tauriInvoke 抛错，前端按 errorMessage 友好降级（不崩）。

import { tauriInvoke, tauriListen, apiBase, getAuthToken } from '@/lib/api';

// === 动态状态（PRD 需求 2：状态动态获取，不存 DB） ===

// 插件动态状态枚举（与 Rust 侧 PluginStatus serde lowercase 对齐）。
// - ready：有完整入口文件 + manifest（可运行/可打开）。
// - incomplete：缺入口文件或 manifest（AI 生成中断或部分产出）。
// - error：manifest 解析失败（JSON 非法 / 缺 id|name / 入口存在但 manifest 损坏）。
// - running：插件正在作为独立进程运行（仅 Python/Node；HTML 无进程概念）。
// - stopped：插件进程已停止（仅 Python/Node 的历史态，重启软件后从 ready 起算）。
export type PluginStatus = 'ready' | 'incomplete' | 'error' | 'running' | 'stopped';

// 插件运行时类型（与契约 RuntimeType 子集对齐：客户端 HTML / Node.js / Python / 云端）。
// 云端插件的逻辑在服务端执行，桌面端仅显示入口（不在本地运行，不在 scan 范围）。
export type PluginRuntime = 'client' | 'nodejs' | 'python';

// 单个插件的状态扫描结果（Rust scan_plugin_status 返回结构，snake_case，serde 默认）。
// id = 插件目录名（持久化目录 plugin_id），name = 用户命名（保存在 manifest.json 的 title 字段，
// 兼容回退到 manifest.name）。
export interface LocalPluginStatus {
  // 插件目录名（plugin_id，与持久化目录 plugins_root/<id>/ 对应）。
  id: string;
  // 插件展示名（用户命名，来源 manifest.title，缺失回退 manifest.name，再缺失回 id）。
  name: string;
  // 动态状态（文件系统扫描判定，见 PluginStatus）。
  status: PluginStatus;
  // 运行时类型（从 manifest.runtime_type 解析，缺失视为 client）。
  runtime: PluginRuntime;
  // manifest 的 entry 字段（client=ui/index.html / nodejs=index.js / python=main.py）。
  entry: string;
  // 插件描述（manifest.description，缺失为空串）。
  description: string;
  // 插件版本（manifest.version，缺失为 '0.0.0'）。
  version: string;
  // 插件图标（manifest.icon，缺失为 undefined；PluginIcon 回退默认 🧩）。
  icon?: string;
  // 运行进程信息（仅 status==='running' 时有意义；其余为 null）。
  pid: number | null;
  // 启动时间 ISO 字符串（仅 running/stopped 态有值）。
  started_at: string | null;
  // 状态诊断说明（缺文件/解析失败的具体原因，便于 UI 展示 incomplete/error 的修复引导）。
  detail: string | null;
  // 是否为未发布草稿（manifest.draft===true）。AI 创建器统一写入 plugins_root，
  // 用 draft 区分未发布草稿与已安装的团队/市场插件，替代旧的 plugins-draft 双轨目录。
  draft: boolean;
}

// === 状态展示文案（PRD AC2：状态 Badge 中文展示） ===

// 状态 → Badge variant（与插件列表行的审核角标风格一致）。
export const STATUS_VARIANT: Record<PluginStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ready: 'secondary',
  incomplete: 'outline',
  error: 'destructive',
  running: 'default',
  stopped: 'outline',
};

// 状态 → 中文展示名（PRD 需求 2 的状态映射）。
export const STATUS_DISPLAY: Record<PluginStatus, string> = {
  ready: '可用',
  incomplete: '未完成',
  error: '异常',
  running: '运行中',
  stopped: '已停止',
};

// 运行时 → 中文展示名（插件类型图标/分类）。
export const RUNTIME_DISPLAY: Record<PluginRuntime, string> = {
  client: '网页',
  nodejs: 'Node.js',
  python: 'Python',
};

// === 启动阶段进度（start_plugin 的分阶段事件，前端渲染动画） ===

// 启动阶段（Rust plugin_runner emit 的 `plugin:start-progress` 事件 stage 取值）。
// - checking：正在检查运行环境/依赖是否就绪。
// - deps_installing：依赖缺失，正在安装（pip install / pnpm install）。
// - starting：依赖就绪，正在拉起入口进程。
export type PluginStartStage = 'checking' | 'deps_installing' | 'starting';

// start_plugin 阶段进度事件 payload（与 Rust PluginStartProgress 对齐，camelCase 由 Tauri 自动转换）。
export interface PluginStartProgress {
  pluginId: string;
  stage: PluginStartStage;
  message: string;
}

// === Rust 命令封装 ===

/**
 * 扫描插件根目录，返回每个插件的动态状态（PRD 需求 2 / AC2）。
 *
 * 组A Rust 后端契约（scan_plugin_status）：
 * - 读取 plugins_root（设置页配置或默认 app_data/plugins/）下的全部子目录。
 * - 每个子目录：解析 manifest.json → 判定状态（ready/incomplete/error）。
 * - status==='running' 由组B 的进程表判定（进程存活即为 running）。
 * - 返回 LocalPluginStatus[]（按 name 或 id 排序）。
 *
 * 失败处理：plugins_root 不存在或读取失败返回空数组（前端降级为空状态引导）。
 */
export function scanPluginStatus(): Promise<LocalPluginStatus[]> {
  return tauriInvoke<LocalPluginStatus[]>('scan_plugin_status');
}

/**
 * 启动插件作为独立进程（PRD 需求 5/7/9 / AC5）。
 *
 * 组B Rust 后端契约（start_plugin）：
 * - Python：在 <插件目录>/.venv/ 创建 venv（若不存在）→ pip install -r requirements.txt（若有）
 *           → 用 .venv 内的 python 运行 entry（Windows .venv\Scripts\python.exe / Unix .venv/bin/python）。
 * - Node：pnpm install（若有依赖）→ pnpm start（package.json scripts.start）。
 * - 进程 detach 后独立运行（外部窗口/终端），软件仅记录 pid + started_at。
 * - HTML 插件不支持 start（仅软件内 iframe，走 open 而非 start）。
 *
 * 启动阶段事件：onProgress 回调接收 Rust emit 的 `plugin:start-progress` 事件（checking /
 * deps_installing / starting），供前端渲染分阶段进度动画。回调在 startPlugin resolve/reject 后自动解绑。
 *
 * 返回启动信息（pid + started_at），前端据此刷新 status==='running'。
 */
export async function startPlugin(
  pluginId: string,
  onProgress?: (progress: PluginStartProgress) => void,
): Promise<{ pid: number; started_at: string }> {
  // 订阅阶段事件（仅本次启动期间），完成后解绑避免泄漏。
  const unlisten = onProgress
    ? await tauriListen<PluginStartProgress>('plugin:start-progress', (event) => {
        // 仅处理本次启动插件的进度事件（同插件并发启动时按 pluginId 过滤）。
        if (event.payload?.pluginId === pluginId) onProgress(event.payload);
      })
    : null;
  try {
    // 计费/中转：把后端基址 + 登录态 token 交给宿主本地桥；插件进程只收到 localhost URL + 一次性 token，
    // 不直接接触 JWT/API Key。
    return await tauriInvoke<{ pid: number; started_at: string }>('start_plugin', {
      pluginId,
      apiBase: apiBase(),
      authToken: getAuthToken() ?? '',
    });
  } finally {
    unlisten?.();
  }
}

/**
 * 停止插件独立进程（PRD AC5：可强制关闭）。
 *
 * 组B Rust 后端契约（stop_plugin）：
 * - 杀 pluginId 对应的进程（含子进程组，与 run_plugin_script 同款杀进程树策略）。
 * - 进程不存在（已退出）幂等返回，不报错。
 * - 停止后 status 刷新为 stopped（scan 重扫时 stop_plugin 进程表标记）。
 */
export function stopPlugin(pluginId: string): Promise<void> {
  return tauriInvoke<void>('stop_plugin', { pluginId });
}

/**
 * 删除本地持久化插件目录（temp 草稿 / 正式本地插件）。
 *
 * 组A Rust 后端契约（delete_plugin）：
 * - sanitize_plugin_id 防穿越 → 若运行中先 stop → remove_dir_all 目录。
 * - 仅删 plugins_root/<pluginId>/，不删云端记录、不删 builtin。
 * - 目录不存在幂等成功。
 */
export function deletePlugin(pluginId: string): Promise<void> {
  return tauriInvoke<void>('delete_plugin', { pluginId });
}

/**
 * 查询单个插件进程的实时运行状态（Rust get_plugin_status 命令）。
 *
 * 组B Rust 后端契约（get_plugin_status）：
 * - 查内存进程表 try_wait 实时判定（比 scan 读磁盘更准），进程已退出时自动清表。
 * - 返回 { running, pid, started_at }。
 *
 * 用途（Task 4b 修复）：ScriptPreviewPanel 在认为插件 running 时周期性轮询，
 * 捕获「插件进程自行退出（脚本跑完 / 用户关掉插件窗口）」场景——此前前端态不会更新，
 * 「强制关闭」按钮常驻、状态卡在 running。轮询发现 running=false 即回退 idle，按钮恢复「运行」。
 */
export interface PluginProcessStatus {
  running: boolean;
  pid: number | null;
  started_at: string | null;
}

export function getPluginStatus(pluginId: string): Promise<PluginProcessStatus> {
  return tauriInvoke<PluginProcessStatus>('get_plugin_status', { pluginId });
}

// === Task 14：插件安全与管理（签名校验 + 版本召回） ===

/** 签名校验结果（Rust verify_plugin_signature_command 返回）。 */
export interface PluginSignatureStatus {
  signed: boolean;
  verified: boolean;
  reason: string;
}

/** 版本召回信息（Rust check_plugin_recall_command 返回）。 */
export interface PluginRecallInfo {
  recalled: boolean;
  version: string;
  reason: string;
}

/** 校验插件签名（minisign）。无签名/未配置公钥返回 signed=false，不抛错。 */
export function verifyPluginSignature(pluginId: string): Promise<PluginSignatureStatus> {
  return tauriInvoke<PluginSignatureStatus>('verify_plugin_signature_command', { pluginId });
}

/** 查询已安装插件版本是否被平台召回（.recalled.json）。 */
export function checkPluginRecall(pluginId: string, installedVersion: string): Promise<PluginRecallInfo> {
  return tauriInvoke<PluginRecallInfo>('check_plugin_recall_command', { pluginId, installedVersion });
}

/**
 * 批量写插件文件到 plugins_root/<pluginId>/（修改已有插件时落盘云端 files）。
 *
 * 组A Rust 后端契约（write_plugin_files）：
 * - sanitize_plugin_id + ensure_plugin_dir 建目录 → 逐文件写（path 白名单防穿越）。
 * - 幂等覆盖同名文件，自动创建子目录（如 ui/）。
 * - 让 AI 进创建器时能 Read 到现有代码并改（而非重新生成）。
 */
export function writePluginFiles(pluginId: string, files: { path: string; content: string }[]): Promise<void> {
  return tauriInvoke<void>('write_plugin_files', { pluginId, files });
}

/**
 * 打开当前插件存放根目录。
 *
 * Rust 侧保证目录存在后交给系统文件管理器打开；失败时返回显式错误。
 */
export function openPluginsRoot(): Promise<void> {
  return tauriInvoke<void>('open_plugins_root');
}

/**
 * 读取插件存放根目录路径（PRD 需求 6 / AC7）。
 *
 * 组A Rust 后端契约（get_plugins_root）：
 * - 默认 app_data/plugins/（首次启动自动创建）。
 * - 用户在设置页改过后持久化到配置文件，返回当前生效路径。
 */
export function getPluginsRoot(): Promise<string> {
  return tauriInvoke<string>('get_plugins_root');
}

/**
 * 配置插件存放根目录路径（PRD AC7）。
 *
 * 组A Rust 后端契约（set_plugins_root）：
 * - 接收新路径，规范化（去尾部斜杠）+ 校验可创建（不存在则 mkdir）。
 * - 已有插件迁移策略由组A 决定（默认：原路径保留，提示用户手动迁移，Constraints 末条）。
 * - 返回最终生效路径（可能与入参不同，如规范化后）。
 */
export function setPluginsRoot(path: string): Promise<string> {
  return tauriInvoke<string>('set_plugins_root', { path });
}

/**
 * 读取本地插件 entry 文件内容（PRD 需求 8：HTML 在软件内 iframe 显示）。
 *
 * 组A Rust 后端契约（read_local_plugin_file）：
 * - 仅允许读取 plugins_root/<pluginId>/ 下的文件（防路径穿越，与现有 read_plugin_file 同款）。
 * - 返回 UTF-8 文本内容（HTML/JSON/源码）。
 */
export function readLocalPluginFile(pluginId: string, file: string): Promise<string> {
  return tauriInvoke<string>('read_local_plugin_file', { pluginId, file });
}
