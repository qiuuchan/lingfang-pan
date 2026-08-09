// 把 @lingfang/plugin-sdk 编译成「纯 JS + .d.ts」产物到 dist/，供 npm 发布使用。
//
// 设计要点（与 P1-a build-adapt.mjs 同源思路，但这里是「库 + CLI」完整产物）：
//   1. esbuild 打单文件 ESM：入口 index / manifest / types/client-entry / cli。
//      - 运行时依赖（@lingfang/contract / jszip）保持「外部」，由消费者从 node_modules 解析，
//        不 inline（inline 会让每个装包都带一份 contract，且破坏 workspace 版本对齐）。
//      - node 内置模块保持外部。
//      - 源码用 `./foo.ts` 显式扩展名 import，resolveExtensions 必须含 .ts。
//   2. .d.ts 由 tsc --emitDeclarationOnly 生成（allowImportingTsExtensions 要求 emitDeclarationOnly）。
//      build tsconfig 清空 `paths`，让 @lingfang/contract 当作外部依赖从 node_modules 解析，
//      避免把 contract 源码拖进本包 emit 并报 rootDir 错误。
//   3. CLI 入口保留 shebang + 可执行位：消费者 `lingfang-plugin` 直接用 node 跑，不需要 tsx。
//
// 发布时由 package.json 的 `publishConfig` 把 main/types/bin/exports 切到 dist；
// 开发态仍指向 src（vite/tsc 直接转译），故本构建不破坏 workspace dev/typecheck。

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** [入口源码, 产物 JS, 是否 bin（需 shebang）] */
const entries = [
  { in: 'src/index.ts', out: 'dist/index.js', bin: false },
  { in: 'src/manifest/index.ts', out: 'dist/manifest/index.js', bin: false },
  { in: 'src/types/client-entry.ts', out: 'dist/types/client-entry.js', bin: false },
  { in: 'src/cli/index.ts', out: 'dist/cli/index.js', bin: true },
];

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // 全部非 node 模块（@lingfang/contract、jszip 等）保持外部，由消费者解析。
  packages: 'external',
  external: ['node:*'],
  resolveExtensions: ['.ts', '.mjs', '.js', '.json'],
  logLevel: 'warning',
  minify: false,
  sourcemap: false,
};

let totalBytes = 0;
for (const e of entries) {
  const outfile = join(packageRoot, e.out);
  await mkdirSync(dirname(outfile), { recursive: true });
  await build({ ...shared, entryPoints: [join(packageRoot, e.in)], outfile });

  if (e.bin) {
    // esbuild 可能吞掉入口首行 shebang，这里兜底补回并确保可执行位。
    const cur = readFileSync(outfile, 'utf-8');
    if (!cur.startsWith('#!')) writeFileSync(outfile, `#!/usr/bin/env node\n${cur}`);
    chmodSync(outfile, 0o755);
  }
  totalBytes += statSync(outfile).size;
}

// 生成 .d.ts（emitDeclarationOnly，不产出 JS，避免覆盖上面 esbuild 的 bundle）。
execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json', '--emitDeclarationOnly'], {
  cwd: packageRoot,
  stdio: 'inherit',
});

process.stdout.write(
  `plugin-sdk 构建完成：JS ${entries.length} 入口 + .d.ts 已写入 dist/（${(totalBytes / 1024).toFixed(0)} KiB JS）\n`
);
