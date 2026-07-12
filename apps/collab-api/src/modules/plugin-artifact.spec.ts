import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inspectPluginArtifact } from './plugin-artifact';

type Entry = {
  name: string;
  content: Buffer;
  declaredSize?: number;
  crc32?: number;
  compression?: 0 | 8;
  externalAttributes?: number;
  dataDescriptor?: boolean;
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(content: Buffer): number {
  let value = 0xffffffff;
  for (const byte of content) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Entry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compression = entry.compression ?? 0;
    const payload = compression === 8 ? deflateRawSync(entry.content) : entry.content;
    const size = entry.declaredSize ?? entry.content.length;
    const checksum = entry.crc32 ?? crc32(entry.content);
    const flags = 0x800 | (entry.dataDescriptor ? 0x08 : 0);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(compression, 8);
    if (!entry.dataDescriptor) {
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(payload.length, 18);
      localHeader.writeUInt32LE(size, 22);
    }
    localHeader.writeUInt16LE(name.length, 26);
    const descriptor = entry.dataDescriptor ? Buffer.alloc(16) : null;
    if (descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(payload.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    local.push(localHeader, name, payload, ...(descriptor ? [descriptor] : []));

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(compression, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(entry.externalAttributes ?? ((0o100644 << 16) >>> 0), 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + payload.length + (descriptor?.length ?? 0);
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, eocd]);
}

const meta = Buffer.from(JSON.stringify({ format: 'lingfang-plugin', formatVersion: 4 }));
const manifest = Buffer.from(JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', runtime_type: 'python', entry: 'main.py' }));

async function inspect(entries: Entry[]) {
  return inspectZip(makeZip(entries));
}

async function inspectZip(zip: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-artifact-test-'));
  const path = join(directory, 'test.lfplugin');
  await writeFile(path, zip);
  try { return await inspectPluginArtifact(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('inspectPluginArtifact', () => {
  it('reads a valid v4 ZIP without loading source files into the response', async () => {
    const result = await inspect([
      { name: '_meta.json', content: meta },
      { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('print(1)') },
    ]);
    expect(result.manifest.version).toBe('1.0.0');
    expect(result.files).toEqual(expect.arrayContaining([{ path: 'main.py', sizeBytes: 8 }]));
  });

  it('accepts a consistent non-ZIP64 data descriptor entry', async () => {
    const result = await inspect([
      { name: '_meta.json', content: meta, dataDescriptor: true },
      { name: 'manifest.json', content: manifest, dataDescriptor: true },
      { name: 'main.py', content: Buffer.from('print(1)'), dataDescriptor: true },
    ]);
    expect(result.manifest.id).toBe('demo');
  });

  it('streams deflated entries to EOF and validates their actual size', async () => {
    const result = await inspect([
      { name: '_meta.json', content: meta, compression: 8 },
      { name: 'manifest.json', content: manifest, compression: 8 },
      { name: 'main.py', content: Buffer.from('print(1)'.repeat(1024)), compression: 8 },
    ]);
    expect(result.files.find((file) => file.path === 'main.py')?.sizeBytes).toBe(8 * 1024);
  });

  it('rejects a data descriptor whose sizes differ from the central directory', async () => {
    const zip = makeZip([
      { name: '_meta.json', content: meta, dataDescriptor: true },
      { name: 'manifest.json', content: manifest, dataDescriptor: true },
      { name: 'main.py', content: Buffer.from('x'), dataDescriptor: true },
    ]);
    const firstDescriptorOffset = 30 + Buffer.byteLength('_meta.json') + meta.length;
    zip.writeUInt32LE(meta.length + 1, firstDescriptorOffset + 8);
    await expect(inspectZip(zip)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it.each([
    ['parent traversal', '../escape', 3],
    ['absolute path', '/escape', 3],
    ['runtime data', 'data/state.json', 3],
    ['nested runtime data', 'src/node_modules/pkg/index.js', 3],
    ['backslash path', 'src\\escape.js', 3],
  ])('rejects %s', async (_label, name, size) => {
    await expect(inspect([
      { name: '_meta.json', content: meta }, { name: 'manifest.json', content: manifest },
      { name, content: Buffer.alloc(size) }, { name: 'main.py', content: Buffer.from('x') },
    ])).rejects.toThrow();
  });

  it('rejects a forged deflate output size and an incorrect CRC', async () => {
    await expect(inspect([
      { name: '_meta.json', content: meta }, { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('A'.repeat(4096)), compression: 8, declaredSize: 1 },
    ])).rejects.toThrow(/实际解压大小|声明大小/);
    await expect(inspect([
      { name: '_meta.json', content: meta }, { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('print(1)'), crc32: 0 },
    ])).rejects.toThrow(/CRC-32/);
  });

  it('rejects duplicate normalized paths', async () => {
    await expect(inspect([
      { name: '_meta.json', content: meta }, { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('x') }, { name: 'main.py', content: Buffer.from('y') },
    ])).rejects.toThrow(/重复路径/);
  });

  it('rejects a symlink entry and oversized declared output before extraction', async () => {
    await expect(inspect([
      { name: '_meta.json', content: meta }, { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('target'), externalAttributes: (0o120777 << 16) >>> 0 },
    ])).rejects.toThrow(/符号链接/);
    await expect(inspect([
      { name: '_meta.json', content: meta }, { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('x'), declaredSize: 61 * 1024 * 1024 },
    ])).rejects.toThrow(/单文件大小超限/);
  });

  it.each([
    ['filename', (zip: Buffer) => { zip[30] = 'x'.charCodeAt(0); }],
    ['flags', (zip: Buffer) => { zip.writeUInt16LE(0, 6); }],
    ['compression', (zip: Buffer) => { zip.writeUInt16LE(8, 8); }],
    ['compressed size', (zip: Buffer) => { zip.writeUInt32LE(meta.length + 1, 18); }],
  ])('rejects a local header whose %s differs from the central directory', async (_label, mutate) => {
    const zip = makeZip([
      { name: '_meta.json', content: meta },
      { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('x') },
    ]);
    mutate(zip);
    await expect(inspectZip(zip)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('rejects local entry offsets that point into the central directory', async () => {
    const zip = makeZip([
      { name: '_meta.json', content: meta },
      { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('x') },
    ]);
    const eocdOffset = zip.length - 22;
    const centralOffset = zip.readUInt32LE(eocdOffset + 16);
    zip.writeUInt32LE(centralOffset, centralOffset + 42);
    await expect(inspectZip(zip)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('returns bad_request instead of RangeError for trailing partial central-directory bytes', async () => {
    const zip = makeZip([
      { name: '_meta.json', content: meta },
      { name: 'manifest.json', content: manifest },
      { name: 'main.py', content: Buffer.from('x') },
    ]);
    const eocdOffset = zip.length - 22;
    zip.writeUInt32LE(zip.readUInt32LE(eocdOffset + 12) + 1, eocdOffset + 12);
    await expect(inspectZip(zip)).rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });
});
