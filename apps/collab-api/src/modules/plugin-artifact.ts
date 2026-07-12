import { createReadStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { badRequest } from '../common';
import { parseStrictSemVer } from './plugin-semver';

export const PLUGIN_ARTIFACT_MAX_BYTES = 300 * 1024 * 1024;
export const PLUGIN_ARTIFACT_MAX_FILES = 1500;
export const PLUGIN_ARTIFACT_MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

type ZipEntry = {
  path: string;
  rawName: Buffer;
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
  recordEnd: number;
};

export type InspectedPluginArtifact = {
  manifest: Record<string, unknown> & {
    id: string;
    name: string;
    version: string;
    description: string;
    runtime_type: 'client' | 'cloud' | 'nodejs' | 'python';
    entry: string;
  };
  files: Array<{ path: string; sizeBytes: number }>;
  uncompressedSizeBytes: number;
};

function safePath(raw: string): string {
  if (raw.includes('\\')) throw badRequest('插件制品路径必须使用正斜杠', { path: raw });
  const path = raw;
  if (!path || path.length > MAX_PATH_BYTES || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    throw badRequest('插件制品包含非法路径', { path: raw });
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw badRequest('插件制品路径不能包含空段、. 或 ..', { path });
  }
  const excluded = new Set(['data', '.git', '.venv', 'venv', 'node_modules', '.lingfang', '__pycache__']);
  if (parts.some((part) => excluded.has(part.toLowerCase()))) {
    throw badRequest('插件制品不能包含数据或运行缓存目录', { path });
  }
  return path;
}

function findEocd(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw badRequest('无效的 ZIP：找不到中央目录');
}

async function readExactly(filePath: string, position: number, length: number): Promise<Buffer> {
  const file = await open(filePath, 'r');
  try {
    return await readExactlyFrom(file, position, length);
  } finally {
    await file.close();
  }
}

async function readExactlyFrom(file: FileHandle, position: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw badRequest('ZIP 条目偏移或长度无效');
  }
  const buffer = Buffer.alloc(length);
  const result = await file.read(buffer, 0, length, position);
  if (result.bytesRead !== length) throw badRequest('ZIP 条目数据不完整');
  return buffer;
}

async function validateLocalEntry(file: FileHandle, entry: ZipEntry, centralOffset: number): Promise<void> {
  if (entry.localOffset + 30 > centralOffset) throw badRequest('ZIP 本地条目偏移损坏', { path: entry.path });
  const header = await readExactlyFrom(file, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw badRequest('ZIP 本地条目头损坏', { path: entry.path });

  const flags = header.readUInt16LE(6);
  const compression = header.readUInt16LE(8);
  const crc32 = header.readUInt32LE(14);
  const compressedSize = header.readUInt32LE(18);
  const uncompressedSize = header.readUInt32LE(22);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (nameLength === 0 || nameLength > MAX_PATH_BYTES || dataOffset > centralOffset || dataEnd > centralOffset) {
    throw badRequest('ZIP 本地条目边界损坏', { path: entry.path });
  }
  if (flags !== entry.flags || compression !== entry.compression) {
    throw badRequest('ZIP 本地条目元数据与中央目录不一致', { path: entry.path });
  }
  const localName = await readExactlyFrom(file, entry.localOffset + 30, nameLength);
  if (!localName.equals(entry.rawName)) throw badRequest('ZIP 本地条目名称与中央目录不一致', { path: entry.path });

  let recordEnd = dataEnd;
  if ((entry.flags & 0x08) === 0) {
    if (crc32 !== entry.crc32 || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
      throw badRequest('ZIP 本地条目大小或校验信息与中央目录不一致', { path: entry.path });
    }
  } else {
    if ((crc32 !== 0 && crc32 !== entry.crc32)
      || (compressedSize !== 0 && compressedSize !== entry.compressedSize)
      || (uncompressedSize !== 0 && uncompressedSize !== entry.uncompressedSize)) {
      throw badRequest('ZIP 数据描述符条目的本地元数据无效', { path: entry.path });
    }
    const available = centralOffset - dataEnd;
    if (available < 12) throw badRequest('ZIP 数据描述符缺失', { path: entry.path });
    const descriptor = await readExactlyFrom(file, dataEnd, Math.min(16, available));
    const matchesDescriptorAt = (candidateOffset: number) => descriptor.length >= candidateOffset + 12
      && descriptor.readUInt32LE(candidateOffset) === entry.crc32
      && descriptor.readUInt32LE(candidateOffset + 4) === entry.compressedSize
      && descriptor.readUInt32LE(candidateOffset + 8) === entry.uncompressedSize;
    const descriptorOffset = descriptor.readUInt32LE(0) === DATA_DESCRIPTOR_SIGNATURE && matchesDescriptorAt(4)
      ? 4
      : matchesDescriptorAt(0) ? 0 : -1;
    if (descriptorOffset < 0) {
      throw badRequest('ZIP 数据描述符与中央目录不一致', { path: entry.path });
    }
    recordEnd += descriptorOffset + 12;
  }
  entry.dataOffset = dataOffset;
  entry.recordEnd = recordEnd;
}

async function readEntries(filePath: string): Promise<ZipEntry[]> {
  const info = await stat(filePath);
  if (info.size <= 0 || info.size > PLUGIN_ARTIFACT_MAX_BYTES) throw badRequest('插件制品大小超限');
  const tailLength = Math.min(info.size, 65_557);
  const tail = await readExactly(filePath, info.size - tailLength, tailLength);
  const eocd = findEocd(tail);
  const disk = tail.readUInt16LE(eocd + 4);
  const centralDisk = tail.readUInt16LE(eocd + 6);
  const diskEntries = tail.readUInt16LE(eocd + 8);
  const totalEntries = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0xffff) {
    throw badRequest('不支持多卷或 ZIP64 制品');
  }
  if (totalEntries > PLUGIN_ARTIFACT_MAX_FILES || centralSize > 16 * 1024 * 1024 || centralOffset + centralSize > info.size) {
    throw badRequest('ZIP 中央目录超限或损坏');
  }

  const central = await readExactly(filePath, centralOffset, centralSize);
  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  let totalBytes = 0;
  while (offset < central.length) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw badRequest('ZIP 中央目录损坏');
    const flags = central.readUInt16LE(offset + 8);
    const compression = central.readUInt16LE(offset + 10);
    const crc32 = central.readUInt32LE(offset + 16);
    const compressedSize = central.readUInt32LE(offset + 20);
    const uncompressedSize = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const diskNumber = central.readUInt16LE(offset + 34);
    const externalAttributes = central.readUInt32LE(offset + 38);
    const localOffset = central.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > central.length || nameLength === 0 || nameLength > MAX_PATH_BYTES) throw badRequest('ZIP 条目名称损坏');
    if ((flags & 0x1) !== 0) throw badRequest('插件制品不能包含加密 ZIP 条目');
    if (compression !== 0 && compression !== 8) throw badRequest('插件制品只允许 store/deflate 压缩');
    if (diskNumber !== 0) throw badRequest('不支持多卷 ZIP 条目');
    const rawNameBytes = Buffer.from(central.subarray(offset + 46, offset + 46 + nameLength));
    const rawName = rawNameBytes.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    if (rawName.endsWith('/')) throw badRequest('插件制品不能包含显式目录条目', { path: rawName });
    const path = safePath(rawName);
    if (paths.has(path)) throw badRequest('插件制品包含重复路径', { path });
    paths.add(path);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw badRequest('插件制品不能包含符号链接', { path });
    if (uncompressedSize > PLUGIN_ARTIFACT_MAX_FILE_BYTES || compressedSize > PLUGIN_ARTIFACT_MAX_BYTES) {
      throw badRequest('插件制品单文件大小超限', { path });
    }
    if (compression === 0 && compressedSize !== uncompressedSize) throw badRequest('ZIP store 条目大小声明不一致', { path });
    totalBytes += uncompressedSize;
    if (totalBytes > PLUGIN_ARTIFACT_MAX_BYTES) throw badRequest('插件制品解压总量超限');
    entries.push({
      path,
      rawName: rawNameBytes,
      flags,
      compression,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset: 0,
      recordEnd: 0,
    });
    offset = end;
  }
  if (entries.length !== totalEntries) throw badRequest('ZIP 条目数量与中央目录不一致');
  const file = await open(filePath, 'r');
  try {
    for (const entry of entries) await validateLocalEntry(file, entry, centralOffset);
  } finally {
    await file.close();
  }
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < byOffset.length; index += 1) {
    if (byOffset[index - 1]!.recordEnd > byOffset[index]!.localOffset) {
      throw badRequest('ZIP 本地条目范围重叠', { path: byOffset[index]!.path });
    }
  }
  return entries;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, chunk: Buffer): number {
  let value = crc;
  for (const byte of chunk) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

async function consumeEntry(filePath: string, entry: ZipEntry, collect: boolean): Promise<Buffer | null> {
  const source = entry.compressedSize === 0
    ? null
    : createReadStream(filePath, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  const stream = entry.compression === 8 && source ? source.pipe(createInflateRaw()) : source;
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let crc = 0xffffffff;
  try {
    if (stream) {
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        outputBytes += chunk.length;
        if (outputBytes > entry.uncompressedSize || outputBytes > PLUGIN_ARTIFACT_MAX_FILE_BYTES) {
          throw badRequest('ZIP 条目实际解压大小超出声明或上限', { path: entry.path });
        }
        crc = updateCrc32(crc, chunk);
        if (collect) chunks.push(chunk);
      }
    } else if (entry.compression === 8) {
      throw badRequest('ZIP 条目解压失败', { path: entry.path });
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'bad_request') throw error;
    throw badRequest('ZIP 条目解压失败', { path: entry.path });
  }
  if (outputBytes !== entry.uncompressedSize) throw badRequest('ZIP 条目声明大小与实际不一致', { path: entry.path });
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw badRequest('ZIP 条目 CRC-32 校验失败', { path: entry.path });
  return collect ? Buffer.concat(chunks, outputBytes) : null;
}

function parseJsonObject(buffer: Buffer, path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw badRequest(`${path} 不是有效的 JSON 对象`);
  }
}

function validateManifest(input: Record<string, unknown>, paths: Set<string>): InspectedPluginArtifact['manifest'] {
  const id = String(input.id || '').trim();
  const name = String(input.name || '').trim();
  const version = String(input.version || '').trim();
  const description = String(input.description || '');
  const runtime = String(input.runtime_type || '').toLowerCase();
  const entry = safePath(String(input.entry || ''));
  if (!id || !name || !version) throw badRequest('manifest.json 缺少 id、name 或 version');
  if (!parseStrictSemVer(version)) throw badRequest('manifest.version 必须是严格 SemVer', { version });
  if (!['client', 'cloud', 'nodejs', 'python'].includes(runtime)) throw badRequest('manifest.runtime_type 不受支持');
  if (!paths.has(entry)) throw badRequest('manifest.entry 指向的文件不存在', { entry });
  return { ...input, id, name, version, description, runtime_type: runtime as InspectedPluginArtifact['manifest']['runtime_type'], entry };
}

export async function inspectPluginArtifact(filePath: string): Promise<InspectedPluginArtifact> {
  const entries = await readEntries(filePath);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const metaEntry = byPath.get('_meta.json');
  const manifestEntry = byPath.get('manifest.json');
  if (!metaEntry || !manifestEntry) throw badRequest('v4 制品必须包含 _meta.json 和 manifest.json');
  let metaBytes: Buffer | null = null;
  let manifestBytes: Buffer | null = null;
  for (const entry of entries) {
    const output = await consumeEntry(filePath, entry, entry === metaEntry || entry === manifestEntry);
    if (entry === metaEntry) metaBytes = output;
    if (entry === manifestEntry) manifestBytes = output;
  }
  if (!metaBytes || !manifestBytes) throw badRequest('v4 制品缺少可读取的元数据');
  const meta = parseJsonObject(metaBytes, '_meta.json');
  if (meta.format !== 'lingfang-plugin' || meta.formatVersion !== 4) throw badRequest('只支持 .lfplugin v4 制品');
  const manifestRaw = parseJsonObject(manifestBytes, 'manifest.json');
  const manifest = validateManifest(manifestRaw, new Set(byPath.keys()));
  return {
    manifest,
    files: entries.map((entry) => ({ path: entry.path, sizeBytes: entry.uncompressedSize })),
    uncompressedSizeBytes: entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
  };
}

export function artifactReadStream(filePath: string) {
  return createReadStream(filePath);
}
