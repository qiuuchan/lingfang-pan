// adapt/workspace.ts —— 插件工作区的读写抽象。
//
// transform 与校验都通过它读写 manifest / 源文件，避免直接散落 fs 调用。
// 所有写操作都落在「临时 adaptation 工作区」（由编排器负责拷贝），
// 因此默认不触碰用户原始源码。

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

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

  /** 解析相对路径并强制约束在工作区根内，防止 `../` 或绝对路径越界读写。 */
  resolveSafe(rel: string): string {
    const base = resolve(this.dir);
    const p = resolve(base, rel);
    if (p !== base && !p.startsWith(base + sep)) {
      throw new Error(`路径越出工作区: ${rel}`);
    }
    return p;
  }

  readManifest(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.manifestPath(), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }

  writeManifest(manifest: Record<string, unknown>): void {
    writeFileSync(this.manifestPath(), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }

  /** 相对工作区的路径是否存在（文件或目录）。越界路径视为不存在。 */
  exists(rel: string): boolean {
    try {
      return existsSync(this.resolveSafe(rel));
    } catch {
      return false;
    }
  }

  /** 读取源文件内容，不存在返回 null。越界路径视为不存在。 */
  readFile(rel: string): string | null {
    let p: string;
    try {
      p = this.resolveSafe(rel);
    } catch {
      return null;
    }
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  }

  /** 写入源文件（自动建父目录）。越界路径抛错，防止整条流水线被不可信 entry 带偏。 */
  writeFile(rel: string, content: string): void {
    const p = this.resolveSafe(rel);
    mkdirSync(dirname(p), { recursive: true });
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
