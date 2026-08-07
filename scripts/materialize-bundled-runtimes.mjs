#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(process.argv[2] ?? join(repoRoot, 'apps', 'desktop', 'runtimes'));
const lockPath = join(runtimeRoot, 'runtime-lock.json');

if (!existsSync(lockPath)) fail(`missing lock file: ${lockPath}`);
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));

for (const entry of lock.materializedFiles ?? []) {
  await materialize(entry);
}

async function materialize(entry) {
  const target = join(runtimeRoot, entry.path);
  if (await matches(target, entry)) return;
  const partsRoot = resolve(runtimeRoot, entry.partsRoot ?? '.');

  for (const part of entry.parts ?? []) {
    const partPath = join(partsRoot, part);
    if (!existsSync(partPath) || !statSync(partPath).isFile())
      fail(`missing runtime part: ${part}`);
  }
  if (!entry.parts?.length) fail(`no runtime parts configured: ${entry.path}`);

  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.materializing`;
  rmSync(temporary, { force: true });
  try {
    for (const [index, part] of entry.parts.entries()) {
      const output = createWriteStream(temporary, { flags: index === 0 ? 'wx' : 'a' });
      await pipeline(createReadStream(join(partsRoot, part)), output);
    }
    if (!(await matches(temporary, entry)))
      fail(`materialized file checksum mismatch: ${entry.path}`);
    renameSync(temporary, target);
    process.stdout.write(`[runtimes] materialized ${entry.path}\n`);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function matches(path, entry) {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size !== entry.size) return false;
  return (await sha256(path)) === entry.sha256;
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function fail(message) {
  process.stderr.write(`[runtimes] ${message}\n`);
  process.exit(1);
}
