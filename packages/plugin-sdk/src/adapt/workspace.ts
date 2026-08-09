// adapt/workspace.ts —— 插件工作区的读写抽象。
//
// transform 与校验都通过它读写 manifest / 源文件，避免直接散落 fs 调用。
// 所有写操作都落在「临时 adaptation 工作区」（由编排器负责拷贝），
// 因此默认不触碰用户原始源码。

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';

export class AdaptWorkspace {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  manifestPath(): string {
    return join(this.dir, 'manifest.json');
  }

  hasManifest(): boolean {
    return existsSync(this.manifestPath());
  }

  readManifest(): Record<string, unknown> {
    const raw = readFileSync(this.manifestPath(), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  writeManifest(manifest: Record<string, unknown>): void {
    writeFileSync(this.manifestPath(), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }

  /** 相对工作区的路径是否存在（文件或目录）。 */
  exists(rel: string): boolean {
    return existsSync(join(this.dir, rel));
  }

  /** 读取源文件内容，不存在返回 null。 */
  readFile(rel: string): string | null {
    const p = join(this.dir, rel);
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  }

  /** 写入源文件（自动建父目录）。 */
  writeFile(rel: string, content: string): void {
    const p = join(this.dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  }

  /** 列出工作区顶层与递归文件（相对路径，正斜杠），用于能力探测等。 */
  listFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (['node_modules', '.git', 'data', '.venv', 'venv', '__pycache__'].includes(e.name)) continue;
          walk(abs);
        } else if (e.isFile()) {
          out.push(relative(this.dir, abs).split('\\').join('/'));
        }
      }
    };
    walk(this.dir);
    return out;
  }

  /** 递归读取所有源文件内容（相对路径 → 内容），用于 AI 边界/能力扫描。 */
  readAllSources(): Map<string, string> {
    const map = new Map<string, string>();
    for (const rel of this.listFiles()) {
      if (rel === 'manifest.json' || rel === '_meta.json') continue;
      if (/\.(py|js|mjs|cjs|ts|tsx|html|json|txt|md)$/.test(rel)) {
        const c = this.readFile(rel);
        if (c != null) map.set(rel, c);
      }
    }
    return map;
  }

  isEmpty(): boolean {
    try {
      return statSync(this.dir).isDirectory() && readdirSync(this.dir).length === 0;
    } catch {
      return true;
    }
  }
}
