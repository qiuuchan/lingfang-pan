#!/usr/bin/env node

// 把适配引擎单文件产物（packages/plugin-sdk/dist/adapt.mjs）materialize 到
// apps/desktop/adapt/adapt.mjs，供 Tauri 作为资源（tauri.conf.json bundle.resources 的
// "../adapt": "adapt"）打包进安装包。与 materialize-bundled-runtimes.mjs 同样的约定：
// 源产物是 gitignored 的构建产物，通过本脚本在 dev / build 前生成，不入库。
//
// 约定：
// - 源缺失时自动用 esbuild 重新打包 plugin-sdk（node scripts/build-adapt.mjs），不依赖 pnpm 解析。
// - 落盘走 temp + rename 原子替换；缺失即报错退出（让 dev / build 早期失败，而非静默缺资源）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(repoRoot, 'packages', 'plugin-sdk', 'dist', 'adapt.mjs');
const targetDir = join(repoRoot, 'apps', 'desktop', 'adapt');
const targetPath = join(targetDir, 'adapt.mjs');

if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
  process.stdout.write('[adapt] 源产物缺失，触发 plugin-sdk 打包（node scripts/build-adapt.mjs）…\n');
  const buildScript = join(repoRoot, 'packages', 'plugin-sdk', 'scripts', 'build-adapt.mjs');
  if (!existsSync(buildScript)) {
    process.stderr.write(`[adapt] 找不到打包脚本：${buildScript}\n`);
    process.exit(1);
  }
  try {
    execFileSync('node', [buildScript], { stdio: 'inherit' });
  } catch (error) {
    process.stderr.write(`[adapt] 打包适配引擎失败：${error?.message ?? error}\n`);
    process.exit(1);
  }
  if (!existsSync(sourcePath)) {
    process.stderr.write(`[adapt] 打包后仍未生成：${sourcePath}\n`);
    process.exit(1);
  }
}

mkdirSync(targetDir, { recursive: true });
const temporary = `${targetPath}.materializing`;
rmSync(temporary, { force: true });
try {
  // 单文件复制（源已是 esbuild 打的 bundle，无需分块拼接）。
  writeFileSync(temporary, readFileSync(sourcePath));
  renameSync(temporary, targetPath);
  process.stdout.write(`[adapt] materialized ${targetPath}\n`);
} catch (error) {
  rmSync(temporary, { force: true });
  process.stderr.write(`[adapt] 落地适配引擎失败：${error?.message ?? error}\n`);
  process.exit(1);
}
