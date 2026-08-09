// adapt 命令：运行插件「适配检验改造」流水线（见 design.md 适配流水线章节）。
// 默认拷贝到临时工作区、应用确定性自动改造、重新校验、可选执行确证、可选重新打包。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runAdaptation, type AdaptOptions } from '../../adapt/index.ts';
import { log } from '../log.ts';

export interface AdaptCliOptions {
  path?: string;
  execute?: boolean;
  repack?: boolean;
  out?: string;
  inPlace?: boolean;
  forceReDerive?: boolean;
  json?: boolean;
}

/**
 * 适配命令入口。
 * @returns 退出码：0 通过（含仅 warnings），1 校验/执行失败，2 用法错误。
 */
export async function adaptCommand(_argv: string[], opts?: AdaptCliOptions): Promise<number> {
  const pluginPath = path.resolve(
    opts?.path && opts.path.length > 0 ? opts.path : typeof _argv[0] === 'string' ? _argv[0] : process.cwd()
  );
  if (!existsSync(pluginPath)) {
    return printError('path_not_found', `插件目录不存在: ${pluginPath}`, opts?.json ?? false);
  }

  const exec = opts?.execute === true;
  const runOpts: AdaptOptions = {
    pluginDir: pluginPath,
    execute: exec,
    repack: opts?.repack === true,
    outDir: opts?.out ? path.resolve(opts.out) : undefined,
    inPlace: opts?.inPlace === true,
    forceReDerive: opts?.forceReDerive === true,
  };

  try {
    // 主流程始终运行「校验 + 确定性改造 + 重新校验」；--execute 额外做运行时确证。
    const result = await runAdaptation({ ...runOpts, execute: exec });

    if (opts?.json ?? false) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      printHuman(result);
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    return printError('adapt_failed', `适配失败: ${(e as Error).message}`, opts?.json ?? false);
  }
}

function printHuman(r: { ok: boolean; summary: string; fixesApplied: Array<{ code: string; message: string; path?: string }>; remaining: Array<{ severity: string; category: string; message: string; path?: string }>; canRun?: boolean; runEvidence?: Array<{ method: string; passed: boolean; detail?: string }> }): void {
  const lines: string[] = [];
  lines.push(`\n适配检验改造：${r.summary}\n`);

  if (r.fixesApplied.length) {
    lines.push('✓ 已应用的自动改造:');
    for (const f of r.fixesApplied) lines.push(`   - [${f.code}] ${f.message}${f.path ? ` (${f.path})` : ''}`);
  }
  if (r.remaining.length) {
    lines.push('✗ 仍需人工/agent 处理:');
    for (const i of r.remaining) lines.push(`   - [${i.severity}] ${i.category}: ${i.message}${i.path ? ` (${i.path})` : ''}`);
  }
  if (r.runEvidence) {
    lines.push('\n运行时确证:');
    for (const e of r.runEvidence) {
      lines.push(`   ${e.passed ? '✓' : '✗'} ${e.method}: ${e.detail ?? ''}`);
    }
    lines.push(`   结论：${r.canRun ? '可运行' : '未能确证可运行'}`);
  }
  if (!r.fixesApplied.length && !r.remaining.length) {
    lines.push('   （无需改造）');
  }
  console.log(lines.join('\n'));
}

function printError(code: string, message: string, json: boolean): number {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }, null, 2) + '\n');
  } else {
    log.error(`${code}: ${message}`);
  }
  return code === 'path_not_found' ? 2 : 1;
}
