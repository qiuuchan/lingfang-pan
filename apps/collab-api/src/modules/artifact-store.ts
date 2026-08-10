import { Logger } from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export const ARTIFACT_STORE = Symbol('ARTIFACT_STORE');

/** 路径不存在（ENOENT）。清理链路据此区分「本来就没有」与「读不动」。 */
export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

export type ArtifactDownload =
  | { kind: 'stream'; stream: NodeJS.ReadableStream; sizeBytes: number }
  | { kind: 'redirect'; url: string };

/** 制品在存储后端中不存在（已被清理或从未落盘）。service 层据此映射 HTTP 410。 */
export class ArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactUnavailableError';
  }
}

export interface ArtifactStore {
  promote(tempPath: string, artifactKey: string, sha256: string): Promise<void>;
  download(artifactKey: string): Promise<ArtifactDownload>;
  delete(artifactKey: string): Promise<void>;
  cleanupOrphans(referencedKeys: Set<string>, olderThanMs: number): Promise<number>;
}

function assertArtifactKey(key: string): string {
  const normalized = key.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid artifact key');
  }
  return normalized;
}

export class FilesystemArtifactStore implements ArtifactStore {
  private readonly logger = new Logger(FilesystemArtifactStore.name);
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string) {
    const path = resolve(this.root, assertArtifactKey(key));
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`))
      throw new Error('Artifact path escapes root');
    return path;
  }

  async promote(tempPath: string, artifactKey: string): Promise<void> {
    const target = this.pathFor(artifactKey);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(tempPath, target);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EXDEV')
        throw error;
      const copyTarget = `${target}.staging-${randomUUID()}`;
      try {
        await copyFile(tempPath, copyTarget, constants.COPYFILE_EXCL);
        await rename(copyTarget, target);
        await rm(tempPath, { force: true });
      } catch (copyError) {
        await rm(copyTarget, { force: true });
        throw copyError;
      }
    }
  }

  async download(artifactKey: string): Promise<ArtifactDownload> {
    const path = this.pathFor(artifactKey);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new ArtifactUnavailableError(`artifact not found: ${artifactKey}`);
      }
      throw new Error(`读取制品失败：${artifactKey}`, { cause: error });
    }
    return { kind: 'stream', stream: createReadStream(path), sizeBytes: info.size };
  }

  async delete(artifactKey: string): Promise<void> {
    await rm(this.pathFor(artifactKey), { force: true });
  }

  async cleanupOrphans(referencedKeys: Set<string>, olderThanMs: number): Promise<number> {
    let removed = 0;
    const walk = async (directory: string): Promise<void> => {
      // 目录不存在 = 没有孤儿要清，属幂等正常路径；其余 I/O 故障（EPERM/EBUSY/EMFILE）
      // 必须炸出来，否则「清理失败」会被伪装成「清理了 0 个」，孤儿制品无声堆积。
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
        if (isMissingPathError(error)) return null;
        this.logger.error(
          `扫描制品目录失败：${directory}`,
          error instanceof Error ? error.stack : String(error)
        );
        throw new Error(`扫描制品目录失败：${directory}`, { cause: error });
      });
      if (entries === null) return;
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.lfplugin')) continue;
        const key = path
          .slice(this.root.length + 1)
          .split(sep)
          .join('/');
        // 并发清理把文件抢先删了属正常竞态，跳过即可；其余故障同样必须上抛。
        const info = await stat(path).catch((error: unknown) => {
          if (isMissingPathError(error)) return null;
          this.logger.error(
            `读取制品状态失败：${path}`,
            error instanceof Error ? error.stack : String(error)
          );
          throw new Error(`读取制品状态失败：${path}`, { cause: error });
        });
        if (info === null) continue;
        if (!referencedKeys.has(key) && Date.now() - info.mtimeMs >= olderThanMs) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
    };
    await walk(this.root);
    return removed;
  }
}

type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
};

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export class S3ArtifactStore implements ArtifactStore {
  constructor(private readonly config: S3Config) {}

  private objectUrl(key: string): URL {
    const endpoint = new URL(this.config.endpoint);
    const encodedKey = assertArtifactKey(key).split('/').map(awsEncode).join('/');
    if (this.config.pathStyle)
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${awsEncode(this.config.bucket)}/${encodedKey}`;
    else {
      endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${encodedKey}`;
    }
    return endpoint;
  }

  private signingKey(date: string): Buffer {
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, 's3');
    return hmac(serviceKey, 'aws4_request');
  }

  private authorization(method: string, url: URL, payloadHash: string, now: Date) {
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join(
      '\n'
    );
    const scope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
    const signature = createHmac('sha256', this.signingKey(shortDate))
      .update(stringToSign)
      .digest('hex');
    return {
      authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      amzDate,
    };
  }

  private presignedGet(key: string, expiresSeconds = 300): string {
    const url = this.objectUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const scope = `${shortDate}/${this.config.region}/s3/aws4_request`;
    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': 'host',
    });
    const canonicalQuery = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${awsEncode(k)}=${awsEncode(v)}`)
      .join('&');
    const canonical = [
      'GET',
      url.pathname,
      canonicalQuery,
      `host:${url.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
    params.set(
      'X-Amz-Signature',
      createHmac('sha256', this.signingKey(shortDate)).update(stringToSign).digest('hex')
    );
    url.search = params.toString();
    return url.toString();
  }

  async promote(tempPath: string, artifactKey: string, sha256: string): Promise<void> {
    const url = this.objectUrl(artifactKey);
    const { authorization, amzDate } = this.authorization('PUT', url, sha256, new Date());
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': sha256,
        'content-type': 'application/vnd.lingfang.plugin+zip',
      },
      body: Readable.toWeb(createReadStream(tempPath)) as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!response.ok) throw new Error(`S3 put failed: ${response.status}`);
    await rm(tempPath, { force: true });
  }

  async download(artifactKey: string): Promise<ArtifactDownload> {
    try {
      return { kind: 'redirect', url: this.presignedGet(artifactKey) };
    } catch (error) {
      throw new Error(`生成制品下载地址失败：${artifactKey}`, { cause: error });
    }
  }

  async delete(artifactKey: string): Promise<void> {
    const url = this.objectUrl(artifactKey);
    const emptyHash = createHash('sha256').update('').digest('hex');
    const { authorization, amzDate } = this.authorization('DELETE', url, emptyHash, new Date());
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { authorization, 'x-amz-date': amzDate, 'x-amz-content-sha256': emptyHash },
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`S3 delete failed: ${response.status}`);
  }

  async cleanupOrphans(): Promise<number> {
    // S3/MinIO deployments should pair this adapter with a bucket lifecycle rule for orphan expiry.
    // The service cannot safely list arbitrary shared buckets without a dedicated prefix policy.
    return 0;
  }
}

export function createArtifactStore(env: NodeJS.ProcessEnv = process.env): ArtifactStore {
  if ((env.PLUGIN_ARTIFACT_DRIVER || 'filesystem').toLowerCase() === 's3') {
    const required = [
      'PLUGIN_S3_ENDPOINT',
      'PLUGIN_S3_BUCKET',
      'PLUGIN_S3_ACCESS_KEY_ID',
      'PLUGIN_S3_SECRET_ACCESS_KEY',
    ] as const;
    for (const key of required)
      if (!env[key]) throw new Error(`${key} is required for S3 artifact storage`);
    return new S3ArtifactStore({
      endpoint: env.PLUGIN_S3_ENDPOINT!,
      region: env.PLUGIN_S3_REGION || 'us-east-1',
      bucket: env.PLUGIN_S3_BUCKET!,
      accessKeyId: env.PLUGIN_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.PLUGIN_S3_SECRET_ACCESS_KEY!,
      pathStyle: env.PLUGIN_S3_PATH_STYLE !== 'false',
    });
  }
  return new FilesystemArtifactStore(
    env.PLUGIN_ARTIFACT_DIR || join(process.cwd(), 'artifacts', 'plugins')
  );
}
