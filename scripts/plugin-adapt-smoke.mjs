#!/usr/bin/env node

// 插件「适配检验改造」流水线端到端冒烟：
//   样例插件目录 → 适配引擎(adapt.mjs) 改造 + 运行时确证 + 重打包 .lfplugin
//                → 暂存 AdaptationReport 换 reportId
//                → 带 reportId 上传发布（服务端摄入闸复核 + 留证）
//
// 用法：
//   node scripts/plugin-adapt-smoke.mjs                # 三个 runtime 全跑
//   node scripts/plugin-adapt-smoke.mjs --only python  # 只跑指定用例（逗号分隔）
//   node scripts/plugin-adapt-smoke.mjs --probes       # 额外跑已知集成缺陷探针
//   node scripts/plugin-adapt-smoke.mjs --no-upload    # 只跑引擎，不碰服务端
//   node scripts/plugin-adapt-smoke.mjs --no-execute   # 跳过运行时确证（无内置运行时的机器）
//   node scripts/plugin-adapt-smoke.mjs --keep         # 保留临时工作区/产物，便于人工看 diff
//   node scripts/plugin-adapt-smoke.mjs --help
//
// 依赖：
//   - packages/plugin-sdk/dist/adapt.mjs（缺失时自动 node packages/plugin-sdk/scripts/build-adapt.mjs）
//   - 运行中的 collab-api（默认 http://localhost:19006，可用 API_BASE 覆盖）；
//     演示团队 / demo-user 由 _smoke-helpers.mjs 幂等确保。
//   - 运行时确证优先用 apps/desktop/runtimes 下的内置 python / node（与 plugin_adapt.rs 一致），
//     没有就退回 PATH。
//
// 设计要点：
//   - 引擎子进程必须**并发**收 stdout + stderr（协议返回的报告 JSON 可达数十 KiB，
//     管道写满就死锁；这是 3c4b3408 已经踩过的坑，脚本侧不能重演）。
//   - 每次跑都会把 fixture 拷到临时目录并给 manifest.name 追加 runId，
//     让 A1 派生出的插件 id 唯一，避免第二次跑撞上「该版本已经发布且不可覆盖」。
//   - 脚本只读 fixtures，改造与打包一律落在系统临时目录。

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminLogin, ensureDemoTenant, auth, jreq, API } from './_smoke-helpers.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = join(repoRoot, 'packages', 'plugin-sdk', 'dist', 'adapt.mjs');
const buildScript = join(repoRoot, 'packages', 'plugin-sdk', 'scripts', 'build-adapt.mjs');
const fixturesRoot = join(repoRoot, 'scripts', 'fixtures', 'plugin-adapt');

// 默认集：三个 runtime 的最小可运行样例，期望全绿（改造 → 确证 → 打包 → 留证 → 发布 闭环）。
const CASES = [
  { runtime: 'python', dir: 'python', expectRuntimeType: 'python' },
  { runtime: 'node', dir: 'node', expectRuntimeType: 'nodejs' },
  { runtime: 'client', dir: 'client', expectRuntimeType: 'client' },
];

// 缺陷探针：已知「引擎判 ADAPTED_PASSED ↔ 服务端 AI 策略闸门拒收」的不对齐场景。
// 默认不跑（否则 CI 长红），用 --probes 或 --only <name> 显式触发；命中记 DEFECT、退出码 2。
const PROBES = [
  // 引擎 A4 把独立 .js 里的硬编码 base URL 改写成带空兜底的桥接写法，
  // 服务端策略闸门则把「自定义 bridge 兜底」判为 ai.bridge.custom 拒收。
  { runtime: 'client-a4gap', dir: 'client-a4gap', expectRuntimeType: 'client', probe: true },
  // 插件依赖第三方 AI SDK。引擎静态分析只看硬编码 key/url/provider/model，不查 SDK 依赖，
  // 于是给出 ADAPTED_PASSED；服务端却以 ai.sdk.third_party 拒绝发布。
  { runtime: 'node-sdk', dir: 'node-sdk', expectRuntimeType: 'nodejs', probe: true },
];

const ALL_CASES = [...CASES, ...PROBES];

function parseArgs(argv) {
  const opts = { only: null, upload: true, execute: true, keep: false, probes: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--probes') opts.probes = true;
    else if (arg === '--no-upload') opts.upload = false;
    else if (arg === '--no-execute') opts.execute = false;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--only') opts.only = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (arg.startsWith('--only=')) opts.only = arg.slice('--only='.length).split(',').filter(Boolean);
    else throw new Error(`未知参数：${arg}（用 --help 看用法）`);
  }
  return opts;
}

const HELP = `插件适配检验改造流水线 端到端冒烟

用法: node scripts/plugin-adapt-smoke.mjs [选项]

选项:
  --only <a,b>   只跑指定用例（python | node | client | client-a4gap | node-sdk），逗号分隔
  --probes       额外跑「已知集成缺陷探针」（client-a4gap、node-sdk），默认不跑
  --no-upload    只跑本地适配引擎，不调用 collab-api（无需起服务）
  --no-execute   跳过运行时确证（py_compile / node --check / HTML 检查）
  --keep         保留临时工作区与 .lfplugin 产物路径，便于人工复核 diff
  -h, --help     显示本帮助

退出码:
  0  选中的用例全部闭环
  1  冒烟链路故障（引擎崩了 / 留证失败 / 服务端不可达）—— 先修依赖
  2  链路通但抓到集成缺陷（引擎判通过、服务端策略闸门拒收）—— 记缺陷待修

环境变量:
  API_BASE       collab-api 基址，默认 http://localhost:19006
  SMOKE_RUN_ID   自定义本次运行标识（默认取当前时间的 base36），决定派生的插件 id 后缀
`;

/** 缺产物就现打一个（与 materialize-adapt-engine.mjs 同一套约定）。 */
function ensureEngine() {
  if (existsSync(enginePath)) return;
  console.log('== 0) adapt.mjs 缺失，触发 plugin-sdk 打包 ==');
  if (!existsSync(buildScript)) throw new Error(`找不到打包脚本：${buildScript}`);
  execFileSync(process.execPath, [buildScript], { stdio: 'inherit' });
  if (!existsSync(enginePath)) throw new Error(`打包后仍未生成：${enginePath}`);
}

/** 内置运行时优先（与 plugin_adapt.rs 注入 runtime.{pythonExe,nodeExe} 的做法一致）。 */
function resolveBundledRuntimes() {
  const base = join(repoRoot, 'apps', 'desktop', 'runtimes');
  const pick = (...candidates) => candidates.find((p) => existsSync(p));
  return {
    pythonExe: pick(
      join(base, 'python', 'python.exe'),
      join(base, 'python', 'bin', 'python3'),
      join(base, 'python', 'python3')
    ),
    nodeExe: pick(
      join(base, 'nodejs', 'node.exe'),
      join(base, 'nodejs', 'bin', 'node'),
      join(base, 'nodejs', 'node')
    ),
  };
}

/**
 * 按 bin.ts 协议跑一次适配引擎。
 * stdout / stderr 必须在写 stdin 之前就挂上监听并并发排空，否则报告一大就死锁。
 */
function runEngine(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [enginePath], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    // 读端就绪后再喂请求；EPIPE 交给 close 事件统一收敛，不让脚本崩在写侧。
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

/** 把 fixture 拷到临时目录，并给 name 追加 runId —— A1 会据此派生唯一插件 id。 */
function stageFixture(fixtureDir, runId) {
  const staging = mkdtempSync(join(tmpdir(), 'lingfang-adapt-smoke-'));
  cpSync(fixtureDir, staging, { recursive: true });
  const manifestPath = join(staging, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = `${manifest.name}-${runId}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return staging;
}

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');

/**
 * 改造产物必须仍然是合法代码。
 * A4（AI 边界归一化）会重写 .js/.mjs/.cjs，而 client 运行时确证只验 HTML、不验脚本，
 * 语法被改坏也能拿到 canRun=true —— 这条断言就是用来兜住那个盲区的。
 */
function checkWorkspaceSyntax(workspaceDir) {
  const broken = [];
  if (!workspaceDir || !existsSync(workspaceDir)) return broken;
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(?:js|mjs|cjs)$/.test(item.name)) continue;
      try {
        execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
      } catch (error) {
        const stderr = String(error.stderr ?? '');
        const message = stderr.split('\n').find((line) => /Error/.test(line))?.trim() ?? '语法检查失败';
        broken.push({ file: abs.slice(workspaceDir.length + 1), message });
      }
    }
  };
  walk(workspaceDir);
  return broken;
}

/** 逐条打印改造/残留明细：这份输出会被文档站直接引用，格式要稳定可读。 */
function printDetail(title, list, render) {
  const items = Array.isArray(list) ? list : [];
  console.log(`   ${title} = ${items.length} 项${items.length === 0 ? '（无）' : ''}`);
  for (const item of items) console.log(`       · ${render(item)}`);
}

async function stageReport(token, report) {
  const response = await jreq(
    await fetch(`${API}/api/plugin-registry/adaptation-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify({ report }),
    })
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `暂存适配报告失败 ${response.status}: ${JSON.stringify(response.json ?? response.text).slice(0, 300)}`
    );
  }
  return response.json;
}

async function publish(token, artifactPath, reportId, label) {
  const bytes = readFileSync(artifactPath);
  const response = await jreq(
    await fetch(`${API}/api/plugin-registry/releases`, {
      method: 'POST',
      headers: {
        // 与 plugin_package_manager/network.rs::artifact_upload_headers 对齐
        'content-type': 'application/vnd.lingfang.plugin+zip',
        'content-length': String(bytes.length),
        'x-client': 'desktop',
        'x-plugin-source-kind': 'LOCAL_ARTIFACT',
        'x-plugin-source-label-b64': b64url(label),
        'x-adaptation-report-id': reportId,
        ...auth(token),
      },
      body: bytes,
    })
  );
  return { ...response, sizeBytes: bytes.length };
}

async function runCase(testCase, ctx) {
  const label = `冒烟 ${testCase.runtime} 样例`;
  const fixtureDir = join(fixturesRoot, testCase.dir);
  // 单个样例缺失只判该用例失败，不能把整轮冒烟带崩。
  if (!existsSync(join(fixtureDir, 'manifest.json'))) {
    console.log(`   × 样例缺失或不完整：${fixtureDir}`);
    return {
      runtime: testCase.runtime,
      probe: testCase.probe === true,
      ok: false,
      defect: false,
      stage: 'fixture',
      problems: [],
      error: `样例目录缺少 manifest.json：${fixtureDir}`,
    };
  }

  const staging = stageFixture(fixtureDir, ctx.runId);
  const outDir = mkdtempSync(join(tmpdir(), 'lingfang-adapt-out-'));
  const result = {
    runtime: testCase.runtime,
    probe: testCase.probe === true,
    ok: false,
    defect: false,
    staging,
    outDir,
    stage: 'engine',
    problems: [],
  };

  try {
    const engine = await runEngine({
      mode: 'adapt',
      pluginDir: staging,
      execute: ctx.execute,
      repack: true,
      outDir,
      runtime: ctx.runtimes,
    });
    if (engine.stderr.trim()) console.log(`   [engine stderr] ${engine.stderr.trim().slice(0, 500)}`);
    let payload;
    try {
      payload = JSON.parse(engine.stdout);
    } catch {
      throw new Error(
        `引擎 stdout 不是合法 JSON（exit=${engine.code}）：${engine.stdout.slice(0, 300)}`
      );
    }
    if (!payload.ok) throw new Error(`引擎报错：${payload.error?.message ?? '未知错误'}`);

    const report = payload.report;
    result.report = report;
    result.status = report.status;
    result.canRun = report.canRun;
    result.engineVersion = report.engineVersion;
    result.pluginId = report.pluginId;
    result.fixesApplied = report.fixesApplied?.length ?? 0;
    result.remaining = report.remaining?.length ?? 0;
    result.artifactPath = report.artifactPath;

    console.log(`   runtimeType   = ${report.runtimeType}（期望 ${testCase.expectRuntimeType}）`);
    console.log(`   pluginId      = ${report.pluginId}`);
    console.log(`   status        = ${report.status}  ok=${report.ok}  canRun=${report.canRun}`);
    console.log(`   engineVersion = ${report.engineVersion}`);
    console.log(`   summary       = ${report.summary}`);
    printDetail(
      'fixesApplied ',
      report.fixesApplied,
      (fix) => `${fix.code.padEnd(16)} [${fix.category}] ${fix.path ?? '-'} — ${fix.message}`
    );
    printDetail(
      'remaining    ',
      report.remaining,
      (issue) => `${issue.code.padEnd(16)} [${issue.severity}] ${issue.path ?? '-'} — ${issue.message}`
    );
    for (const evidence of report.runEvidence ?? []) {
      console.log(
        `   runEvidence   · ${evidence.method} passed=${evidence.passed} ${evidence.durationMs ?? '-'}ms ${evidence.detail ?? ''}`
      );
    }
    console.log(`   workspaceDir  = ${report.workspaceDir}`);
    console.log(`   artifactPath  = ${report.artifactPath ?? '（未打包）'}`);

    if (report.runtimeType !== testCase.expectRuntimeType) {
      result.problems.push(`runtime_type 期望 ${testCase.expectRuntimeType}，实际 ${report.runtimeType}`);
    }
    if (result.fixesApplied === 0) result.problems.push('没有任何自动改造被应用（样例失去意义）');
    if (!report.artifactPath || !existsSync(report.artifactPath)) {
      throw new Error(`repack 未产出可用 .lfplugin：${report.artifactPath}`);
    }

    const brokenSources = checkWorkspaceSyntax(report.workspaceDir);
    if (brokenSources.length > 0) {
      console.log(`   × 改造产物语法损坏 ${brokenSources.length} 处（引擎缺陷，运行时确证没兜住）:`);
      for (const item of brokenSources) console.log(`       · ${item.file} — ${item.message}`);
      result.brokenSources = brokenSources;
      result.defect = true;
      for (const item of brokenSources) {
        result.problems.push(`改造产物语法损坏：${item.file} — ${item.message}`);
      }
    }

    if (!ctx.upload) {
      result.ok = result.problems.length === 0;
      result.stage = 'engine-only';
      return result;
    }

    result.stage = 'stage-report';
    const staged = await stageReport(ctx.token, report);
    result.reportId = staged.reportId;
    console.log(`   reportId      = ${staged.reportId}（留证 status=${staged.status}，到期 ${staged.expiresAt}）`);
    if (staged.status !== report.status) {
      result.problems.push(`服务端留证 status=${staged.status} 与客户端 ${report.status} 不一致`);
    }

    result.stage = 'publish';
    const uploaded = await publish(ctx.token, report.artifactPath, staged.reportId, label);
    const upJson = uploaded.json ?? null;
    if (uploaded.status >= 200 && uploaded.status < 300) {
      const release = upJson.release ?? {};
      result.releaseId = release.id;
      result.packageId = upJson.package?.id;
      console.log(
        `   发布成功       packageId=${result.packageId} releaseId=${release.id} version=${release.version} ${uploaded.sizeBytes} 字节`
      );
      console.log(
        `   摄入留证       ingestChannel=${release.ingestChannel} adaptationStatus=${release.adaptationStatus} sourceKind=${release.sourceKind} sourceLabel=${release.sourceLabel}`
      );
      if (release.ingestChannel !== 'ADAPT') {
        result.problems.push(`ingestChannel 期望 ADAPT（报告已兑付），实际 ${release.ingestChannel}`);
      }
      if (release.adaptationStatus !== report.status) {
        result.problems.push(
          `落库 adaptationStatus=${release.adaptationStatus} 与报告 ${report.status} 不一致`
        );
      }
      result.uploadStatus = 'ok';
      result.stage = 'done';
      result.ok = result.problems.length === 0;
      return result;
    }

    // 非 2xx：区分「集成缺陷（服务端策略闸门拒绝改造产物）」与「冒烟链路故障」。
    const isPolicy = upJson && upJson.code === 'plugin_ai_policy_failed';
    const diagnostics = isPolicy && upJson.details ? upJson.details.diagnostics : null;
    result.uploadStatus = isPolicy ? 'policy_rejected' : `http_${uploaded.status}`;
    result.uploadError = upJson ? JSON.stringify(upJson).slice(0, 600) : (uploaded.text ?? '').slice(0, 600);
    if (diagnostics && Array.isArray(diagnostics)) {
      console.log(
        `   发布被服务端 AI 策略闸门拒绝（集成缺陷，HTTP ${uploaded.status}）diagnostics=${diagnostics.length} 条:`
      );
      for (const d of diagnostics) {
        console.log(`       · ${d.code} ${d.path}${d.line ? ':' + d.line : ''} — ${d.message}`);
      }
      result.policyDiagnostics = diagnostics;
      result.defect = true;
      result.problems.push(
        `服务端 AI 策略闸门拒绝改造产物（${diagnostics.length} 项诊断）—— 引擎改造产物与服务端策略闸门未对齐`
      );
    } else {
      console.log(`   发布失败（非策略类，HTTP ${uploaded.status}）：${result.uploadError}`);
      result.problems.push(`上传发布失败 HTTP ${uploaded.status}`);
    }
    result.stage = 'publish-rejected';
    result.ok = false; // 闭环未闭合（被闸门挡下）
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    if (!ctx.keep) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const cases = opts.only
    ? ALL_CASES.filter((c) => opts.only.includes(c.runtime))
    : opts.probes
      ? ALL_CASES
      : CASES;
  if (cases.length === 0) {
    throw new Error(`--only 没有匹配到任何用例（可选：${ALL_CASES.map((c) => c.runtime).join(', ')}）`);
  }

  ensureEngine();
  const runtimes = opts.execute ? resolveBundledRuntimes() : {};
  const runId = process.env.SMOKE_RUN_ID || Date.now().toString(36);

  console.log('== 插件适配检验改造流水线 端到端冒烟 ==');
  console.log(`   引擎产物 ${enginePath}`);
  console.log(`   内置运行时 python=${runtimes.pythonExe ?? '(PATH)'} node=${runtimes.nodeExe ?? '(PATH)'}`);
  console.log(`   runId=${runId} execute=${opts.execute} upload=${opts.upload}`);

  const ctx = { runId, execute: opts.execute, upload: opts.upload, keep: opts.keep, runtimes };
  if (opts.upload) {
    console.log(`== 1) 确保演示团队 / demo-user（幂等）== ${API}`);
    const platformToken = await adminLogin();
    const { teamId, demoToken } = await ensureDemoTenant(platformToken);
    ctx.token = demoToken;
    console.log(`   teamId=${teamId}`);
  }

  const results = [];
  for (const testCase of cases) {
    console.log(`\n== 2) runtime=${testCase.runtime} · ${join('scripts/fixtures/plugin-adapt', testCase.dir)} ==`);
    results.push(await runCase(testCase, ctx));
  }

  console.log('\n== 汇总 ==');
  let passCount = 0;
  let defectCount = 0;
  let failCount = 0;
  for (const r of results) {
    let flag;
    if (r.ok) {
      flag = r.probe ? 'FIXED?' : 'PASS';
      passCount += 1;
    } else if (r.defect) {
      flag = 'DEFECT';
      defectCount += 1;
    } else {
      flag = 'FAIL';
      failCount += 1;
    }
    console.log(
      `   [${flag.padEnd(6)}] ${r.runtime.padEnd(13)} status=${r.status ?? '-'} fixes=${r.fixesApplied ?? '-'} remaining=${r.remaining ?? '-'} canRun=${r.canRun ?? '-'} engine=${r.engineVersion ?? '-'} reportId=${r.reportId ?? '-'}`
    );
    if (r.probe && r.ok) {
      console.log('            i 探针居然闭环了——对应集成缺陷可能已修复，复核后可从 PROBES 移除');
    }
    if (r.error) console.log(`            × 阶段 ${r.stage}：${r.error}`);
    for (const problem of r.problems) console.log(`            ! ${problem}`);
    if (opts.keep) console.log(`            工作区 ${r.staging} / 产物 ${r.outDir}`);
  }

  console.log(`\n统计：PASS=${passCount}  DEFECT(集成缺陷)=${defectCount}  FAIL(链路故障)=${failCount}`);
  if (failCount > 0) {
    console.log(`冒烟链路故障：${results.filter((r) => !r.ok && !r.defect).map((r) => r.runtime).join(', ')}`);
    return 1; // 链路本身坏了（引擎 / 留证 / 网络），先修依赖
  }
  if (defectCount > 0) {
    console.log(
      `冒烟链路跑通，但抓到 ${defectCount} 个集成缺陷：引擎判通过的改造产物被服务端策略闸门拒收，详见上面 DEFECT 项的 diagnostics。`
    );
    return 2; // 链路 OK，集成缺陷（预期要上报/修复）
  }
  console.log(
    `\n冒烟通过：${results.map((r) => r.runtime).join(' / ')} 均完成 改造 → 确证 → 打包 → 留证 → 发布 闭环`
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`冒烟异常：${error?.stack ?? error}`);
    process.exitCode = 1;
  }
);
