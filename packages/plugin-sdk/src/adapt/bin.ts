// adapt/bin.ts —— 适配引擎的进程入口，供桌面端 Rust 侧 spawn。
//
// 桌面端 webview 跑在浏览器上下文里，用不了 node:fs / node:child_process，
// 所以引擎打成单文件 dist/adapt.mjs 随安装包分发，由 Rust 用内置 node 拉起。
//
// 协议（刻意不用命令行参数：Windows 下带空格/中文的路径经 argv 转义极易出错）：
//   stdin  ← 一个 JSON 请求对象
//   stdout → 一行 JSON 响应，且只有这一行（引擎本身不打印任何东西）
//   exit   → 0 成功 / 1 失败，失败时 stdout 仍是可解析的 JSON
// 诊断信息一律走 stderr，不污染 stdout。

import { runAdaptation, validateOnly, type AdaptResult } from './index.ts';
import type { AdaptationReport } from './report.ts';
import type { RuntimeCheckOptions } from './runtime-check.ts';

interface AdaptRequest {
  /** validate = 纯静态校验；adapt = 跑完整改造流水线。 */
  mode?: 'validate' | 'adapt';
  pluginDir?: string;
  /** 直接改造源目录（默认 false，拷到临时工作区，绝不动用户源码）。 */
  inPlace?: boolean;
  /** 是否做运行时确证（短跑/冒烟）。 */
  execute?: boolean;
  /** 是否改造后重新打包成 .lfplugin。 */
  repack?: boolean;
  outDir?: string;
  /** 桌面端注入的内置运行时路径等。 */
  runtime?: RuntimeCheckOptions;
  /** 强制重推导（GitHub 导入）：覆盖而非沿用仓库自带 manifest 的关键字段。 */
  forceReDerive?: boolean;
}

type AdaptResponse =
  | { ok: true; report: AdaptationReport | AdaptResult }
  | { ok: false; error: { message: string } };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseRequest(raw: string): AdaptRequest {
  if (!raw.trim()) throw new Error('缺少 stdin 请求体');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('stdin 请求体不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stdin 请求体必须是 JSON 对象');
  }
  const request = parsed as AdaptRequest;
  if (!request.pluginDir || typeof request.pluginDir !== 'string') {
    throw new Error('请求缺少 pluginDir');
  }
  if (request.mode && request.mode !== 'validate' && request.mode !== 'adapt') {
    throw new Error(`未知 mode：${String(request.mode)}`);
  }
  return request;
}

async function main(): Promise<number> {
  let response: AdaptResponse;
  try {
    const request = parseRequest(await readStdin());
    const report =
      request.mode === 'validate'
        ? await validateOnly(request.pluginDir!)
        : await runAdaptation({
            pluginDir: request.pluginDir!,
            inPlace: request.inPlace,
            execute: request.execute,
            repack: request.repack,
            outDir: request.outDir,
            runtime: request.runtime,
            forceReDerive: request.forceReDerive,
          });
    response = { ok: true, report };
  } catch (error) {
    response = {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
  // 协议约定 stdout 只有一行 JSON；补尾部换行，让按行读取的调用方（Rust read_line）
  // 不必等 EOF 也能拿到完整响应。
  process.stdout.write(JSON.stringify(response) + '\n');
  return response.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // 兜底：main 自身不该抛，但绝不能让调用方拿到空 stdout。
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      }) + '\n'
    );
    process.exitCode = 1;
  }
);
