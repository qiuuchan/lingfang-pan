// adapt/index.ts —— 适配检验改造流水线编排器。
//
// 流程（确定性优先，agent 兜底在桌面端 P1 接入）：
//   1. 把源插件拷贝到临时 adaptation 工作区（不碰用户源码）
//   2. 静态校验 → 问题列表
//   3. 对 fixable 问题应用确定性 transform（A1-A5）→ 写回 manifest
//   4. 重新校验 → 剩余问题（needs_human / 未修）
//   5. 可选：运行时确证（checkRuntime）→ runEvidence / canRun（仅桌面端）
//   6. 可选：重新打包成 .lfplugin（A6）
//
// 产物 AdaptationReport 可由桌面端 UI 展示，或随发布请求上送服务端落库。

import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdaptationIssue, AdaptationReport, FixApplied, RunEvidence } from './report.ts';
import { buildReport } from './report.ts';
import { validateWorkspace } from './validate.ts';
import { applyTransforms } from './transform.ts';
import { checkRuntime, type RuntimeCheckOptions } from './runtime-check.ts';
import { AdaptWorkspace } from './workspace.ts';

const EXCLUDE_COPY = new Set(['node_modules', '.git', 'data', '.venv', 'venv', '__pycache__', '.lingfang', '.mypy_cache', '.pytest_cache']);

export interface AdaptOptions {
  /** 源插件目录（含 manifest.json）。 */
  pluginDir: string;
  /** 是否直接在原地改造（危险，默认 false → 拷贝到临时工作区）。 */
  inPlace?: boolean;
  /** 是否执行运行时确证（仅桌面端/Node 有运行时时 true）。 */
  execute?: boolean;
  /** 是否在改造后重新打包成 .lfplugin（写入 outDir）。 */
  repack?: boolean;
  /** 重新打包输出目录。 */
  outDir?: string;
  /** 运行时检查的可选配置（桌面端注入内置运行时路径）。 */
  runtime?: RuntimeCheckOptions;
}

export interface AdaptResult extends AdaptationReport {
  /** 改造后的工作区目录（临时或原地）。 */
  workspaceDir: string;
  /** 若 repack，打包产物路径。 */
  artifactPath?: string;
}

function copyToTemp(src: string, destParent: string): string {
  const dest = join(destParent, 'adapt-' + Date.now().toString(36));
  mkdtempSync(join(destParent, 'adapt-'));
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const base = p.split(/[\\/]/).pop() ?? '';
      return !EXCLUDE_COPY.has(base);
    },
  });
  return dest;
}

/**
 * 运行插件适配检验改造流水线。
 * 纯读源目录；默认写到临时工作区，绝不修改用户源码。
 */
export async function runAdaptation(opts: AdaptOptions): Promise<AdaptResult> {
  const src = opts.pluginDir;
  if (!existsSync(join(src, 'manifest.json')) && !opts.inPlace) {
    // 即便没有 manifest，也拷贝目录以便 transform 生成
  }
  const workspaceDir = opts.inPlace ? src : copyToTemp(src, tmpdir());
  const ws = new AdaptWorkspace(workspaceDir);

  // 1. 静态校验
  const issues: AdaptationIssue[] = validateWorkspace(ws);

  // 2. 应用确定性改造（只处理 fixable 项；needs_human 留给人工/agent）
  const fixes: FixApplied[] = [];
  let manifest: Record<string, unknown> | null = null;
  if (ws.hasManifest()) {
    manifest = ws.readManifest();
    const applied = applyTransforms(ws, manifest);
    if (applied.length > 0) {
      ws.writeManifest(manifest);
      fixes.push(...applied);
    }
  }

  // 3. 重新校验，得到剩余问题
  const after = validateWorkspace(ws);

  // 4. 运行时确证（可选）
  let runEvidence: RunEvidence[] | undefined;
  let canRun = false;
  if (opts.execute && manifest) {
    runEvidence = await checkRuntime(
      ws,
      { runtime_type: String(manifest.runtime_type ?? 'client'), entry: String(manifest.entry ?? '') },
      opts.runtime ?? {}
    );
    canRun = runEvidence.length > 0 && runEvidence.every((e) => e.passed);
  }

  // 5. 重新打包（可选，A6）
  let artifactPath: string | undefined;
  if (opts.repack && manifest) {
    const { packWorkspace } = await import('../cli/util/archive.ts');
    const packed = await packWorkspace({ workspaceDir, manifest: manifest as never });
    const outDir = opts.outDir ?? src;
    artifactPath = join(outDir, packed.suggestedFilename);
    writeFileSync(artifactPath, packed.buffer);
  }

  const report = buildReport({
    pluginId: manifest?.id as string | undefined,
    runtimeType: manifest?.runtime_type as string | undefined,
    issues: after,
    fixesApplied: fixes,
    canRun,
    runEvidence,
    executed: Boolean(opts.execute),
  });

  // 临时工作区在非原地模式下由调用方决定是否保留；这里不自动清理，便于 UI 展示 diff。
  return { ...report, workspaceDir, artifactPath };
}

/** 仅静态校验（dry-run），不改造、不执行。 */
export async function validateOnly(pluginDir: string): Promise<AdaptationReport> {
  const ws = new AdaptWorkspace(pluginDir);
  const issues = validateWorkspace(ws);
  const manifest = ws.hasManifest() ? (ws.readManifest() as Record<string, unknown>) : undefined;
  return buildReport({
    pluginId: manifest?.id as string | undefined,
    runtimeType: manifest?.runtime_type as string | undefined,
    issues,
    fixesApplied: [],
    executed: false,
  });
}
