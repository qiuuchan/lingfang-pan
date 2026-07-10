#!/usr/bin/env node
// export-plugins.mjs —— 命令行导出 .lfplugin 包（模拟 exportPluginToZip 的 v3 逻辑）。
//
// 用途：在不启动桌面 app 的情况下，把 plugins/<id>/ 导出为 <id>.lfplugin（ZIP），
// 供在 app 内「导入」测试。与 exportPluginToZip (plugin-package-zip.ts) 同款：
//   - 跳过 data/.venv/venv/node_modules/__pycache__/.git 目录 + 隐藏文件（与 list_plugin_files 的 SKIP_DIRS 一致）
//   - 文本文件直存；二进制文件（非 UTF-8）base64 编码 + 记入 _meta.binaryFiles
//   - _meta.json version:3，manifest.json 用磁盘原文件
//
// 用法：node scripts/export-plugins.mjs <plugin-id> [<plugin-id>...] [--source local|draft] [--out dir]
//   默认 source=local，out=plugins/（生成 plugins/<id>.lfplugin）

import { createRequire } from 'module';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = require(join(process.cwd(), 'apps/desktop/node_modules/jszip'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// 与 plugin_store.rs collect_source_paths 的 SKIP_DIRS 一致。
const SKIP_DIRS = new Set(['data', '.venv', 'venv', 'node_modules', '__pycache__', '.git', '.lingfang']);

function parseArgs(argv) {
  const ids = [];
  let source = 'local';
  let out = join(REPO_ROOT, 'plugins');
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') { source = argv[++i]; continue; }
    if (a === '--out') { out = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { source = null; continue; }
    ids.push(a);
  }
  return { ids, source, out };
}

/** 递归枚举插件源文件相对路径（模拟 list_plugin_files 的 collect_source_paths）。 */
function listPluginFiles(pluginDir) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try { entries = readDirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.')) continue; // 隐藏文件/目录（与 collect_source_paths 一致）
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(full);
      } else {
        const rel = relative(pluginDir, full).split(sep).join('/');
        results.push(rel);
      }
    }
  };
  walk(pluginDir);
  return results.sort();
}

// 同步 fs 辅助（避免引入额外依赖，用 readFileSync + 手动 readdir + stat）。
import { readdirSync, statSync } from 'node:fs';
function readDirSync(dir) { return readdirSync(dir); }

/** 判断字节是否为合法 UTF-8（决定文本 vs 二进制）。 */
function isUtf8(bytes) {
  try { const s = Buffer.from(bytes).toString('utf8'); return !s.includes('\uFFFD'); } catch { return false; }
}

async function exportPlugin(pluginId, source, outDir) {
  const pluginDir = join(REPO_ROOT, 'plugins', pluginId);
  if (!existsSync(pluginDir)) throw new Error(`插件目录不存在：${pluginDir}`);
  const paths = listPluginFiles(pluginDir);
  if (paths.length === 0) throw new Error(`插件 ${pluginId} 没有可导出的源文件`);

  const zip = new JSZip();
  let fileCount = 0;
  let displayName = pluginId;
  let manifestText = '';
  const binaryFiles = [];

  for (const p of paths) {
    const full = join(pluginDir, p);
    const bytes = readFileSync(full);
    if (p === 'manifest.json') {
      // manifest 必须是文本；用磁盘原文件。
      manifestText = bytes.toString('utf8');
      try { const m = JSON.parse(manifestText); displayName = m.title || m.name || pluginId; } catch { /* 兜底 */ }
      continue;
    }
    if (isUtf8(bytes)) {
      zip.file(p, bytes.toString('utf8'));
    } else {
      // 二进制：base64 存，记入 binaryFiles（与 exportPluginToZip v3 一致）。
      zip.file(p, bytes.toString('base64'), { base64: true });
      binaryFiles.push(p);
    }
    fileCount += 1;
  }

  if (!manifestText) throw new Error(`插件 ${pluginId} 缺少 manifest.json，无法导出`);
  zip.file('manifest.json', manifestText);
  fileCount += 1;

  const meta = {
    format: 'lingfang-plugin',
    version: 3,
    source,
    exportedAt: new Date().toISOString(),
    name: displayName,
    ...(binaryFiles.length > 0 ? { binaryFiles } : {}),
  };
  zip.file('_meta.json', `${JSON.stringify(meta, null, 2)}\n`);

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${pluginId}.lfplugin`);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  writeFileSync(outFile, buf);
  const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
  console.log(`✅ ${pluginId}.lfplugin  (${sizeMB} MB, ${fileCount} 文件, ${binaryFiles.length} 二进制) → ${relative(REPO_ROOT, outFile)}`);
  return { name: displayName, fileCount, binaryCount: binaryFiles.length, sizeMB };
}

async function main() {
  const { ids, source, out } = parseArgs(process.argv);
  if (source === null || ids.length === 0) {
    console.log('用法: node scripts/export-plugins.mjs <plugin-id>... [--source local|draft] [--out dir]');
    console.log('示例: node scripts/export-plugins.mjs facefusion moneyprinter-turbo pixelle-video huobao-drama');
    process.exit(0);
  }
  if (!['local', 'draft'].includes(source)) {
    console.error(`--source 只允许 local 或 draft，当前：${source}`);
    process.exit(1);
  }
  console.log(`导出 ${ids.length} 个插件（source=${source}, out=${relative(REPO_ROOT, out)}）…`);
  let failed = 0;
  for (const id of ids) {
    try { await exportPlugin(id, source, out); }
    catch (err) { console.error(`❌ ${id}: ${err.message}`); failed += 1; }
  }
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
