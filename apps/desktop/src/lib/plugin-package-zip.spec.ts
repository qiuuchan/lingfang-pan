// plugin-package-zip.spec.ts —— `.lfplugin` ZIP 包导出/导入单测。
//
// 验证：
// - 导出：枚举源文件 + 读内容（跳过二进制占位）→ JSZip 打包 → 含 _meta.json(version:2,source)/manifest.json/源文件。
// - 导入：解析 ZIP → 校验格式/版本 → 按 source 落点（draft→saveDraftPlugin draft:true，local→writePluginFiles 非草稿）。
// - 旧 JSON v1 → 报「旧版 JSON 格式」。
//
// 测试环境为 node（无 document/URL），exportPluginToZip 的下载触发需 mock document/URL 捕获 blob。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';

// vi.hoisted 拿到工厂内可引用的 mock 引用。
const listPluginFilesMock = vi.hoisted(() => vi.fn());
const readLocalPluginFileMock = vi.hoisted(() => vi.fn());
const writePluginFilesMock = vi.hoisted(() => vi.fn());
const saveDraftPluginMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/plugin-status', () => ({
  listPluginFiles: listPluginFilesMock,
  readLocalPluginFile: readLocalPluginFileMock,
  writePluginFiles: writePluginFilesMock,
}));
vi.mock('@/lib/draft-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/draft-plugin')>();
  return { ...actual, saveDraftPlugin: saveDraftPluginMock };
});

import { exportPluginToZip, parsePluginZip, materializeZipPlugin } from './plugin-package-zip';

const PYTHON_MANIFEST = JSON.stringify({
  id: 'videodl',
  name: 'videodl',
  title: '视频下载器',
  version: '0.1.0',
  runtime_type: 'python',
  entry: 'main.py',
  visibility: 'tenant',
  capabilities: [{ kind: 'ui.view', reason: 'GUI', risk: 'none', requires_admin: false }],
});

beforeEach(() => {
  listPluginFilesMock.mockReset();
  readLocalPluginFileMock.mockReset();
  writePluginFilesMock.mockReset();
  saveDraftPluginMock.mockReset();
});

// 导出会触发 document.createElement/URL.createObjectURL（node 环境无），用最简桩捕获 blob。
function stubDocumentDownload(captured: { blob: Blob | null; filename: string | null }) {
  const anchor = { href: '', download: '', click: () => {
    captured.blob = captured.blob; // placeholder；blob 在 createObjectURL 参数里捕获
  } };
  (globalThis as unknown as { document: unknown }).document = {
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => anchor,
  };
  (globalThis as unknown as { URL: unknown }).URL = {
    createObjectURL: (blob: Blob) => { captured.blob = blob; return 'blob:mock'; },
    revokeObjectURL: () => {},
  };
  return anchor;
}

afterEach(() => {
  // 清理全局桩，避免污染其他测试。
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { URL?: unknown }).URL;
});

describe('exportPluginToZip + parsePluginZip 往返', () => {
  it('python 插件导出 → 再解析：含 _meta.json(version:2,source)/manifest.json/源文件，二进制占位被跳过', async () => {
    // 导出：list_plugin_files 返回含二进制占位的文件，read 对二进制返回占位字符串。
    listPluginFilesMock.mockResolvedValue(['manifest.json', 'main.py', 'requirements.txt', 'icon.png']);
    readLocalPluginFileMock.mockImplementation(async (_id: string, file: string) => {
      if (file === 'manifest.json') return PYTHON_MANIFEST;
      if (file === 'main.py') return 'print(1)';
      if (file === 'requirements.txt') return 'videofetch';
      if (file === 'icon.png') return '[binary file, 1024 bytes, non-UTF-8 — 已跳过读取]';
      return '';
    });
    const captured: { blob: Blob | null; filename: string | null } = { blob: null, filename: null };
    const anchor = stubDocumentDownload(captured);

    const result = await exportPluginToZip('videodl', 'local');
    expect(result.name).toBe('视频下载器'); // title 优先
    expect(result.skipped).toBe(1); // icon.png 二进制跳过
    expect(result.fileCount).toBe(3); // manifest + main.py + requirements.txt
    expect(captured.blob).toBeTruthy();
    expect(anchor.download).toBe('videodl.lfplugin');

    // 用导出的 blob 重新解析（模拟导入侧）。
    const file = new File([captured.blob!], 'videodl.lfplugin');
    const parsed = await parsePluginZip(file);
    expect(parsed.source).toBe('local');
    expect(parsed.id).toBe('videodl');
    expect(parsed.name).toBe('视频下载器');
    expect(parsed.manifest.runtime_type).toBe('python');
    expect(parsed.files.map((f) => f.path).sort()).toEqual(['main.py', 'requirements.txt']);
    expect(parsed.files.some((f) => f.path === 'icon.png')).toBe(false); // 二进制未进包
  });

  it('草稿源导出 → source=draft', async () => {
    listPluginFilesMock.mockResolvedValue(['manifest.json', 'main.py']);
    readLocalPluginFileMock.mockImplementation(async (_id: string, file: string) => {
      if (file === 'manifest.json') return JSON.stringify({ id: 'd', name: 'd', title: '草稿名', runtime_type: 'python', entry: 'main.py' });
      return 'print(1)';
    });
    const captured: { blob: Blob | null; filename: string | null } = { blob: null, filename: null };
    stubDocumentDownload(captured);
    await exportPluginToZip('d', 'draft');

    const parsed = await parsePluginZip(new File([captured.blob!], 'd.lfplugin'));
    expect(parsed.source).toBe('draft');
    expect(parsed.name).toBe('草稿名');
  });
});

describe('materializeZipPlugin', () => {
  async function makeZipResult(
    source: 'local' | 'draft',
    id = 'p',
    version = '0.1.0',
  ): Promise<Awaited<ReturnType<typeof parsePluginZip>>> {
    const zip = new JSZip();
    zip.file('_meta.json', JSON.stringify({ format: 'lingfang-plugin', version: 2, source, exportedAt: 'now', name: 'p' }));
    zip.file('manifest.json', JSON.stringify({ id, name: id, version, runtime_type: 'python', entry: 'main.py' }));
    zip.file('main.py', 'print(1)');
    zip.file('requirements.txt', 'videofetch');
    const blob = await zip.generateAsync({ type: 'blob' });
    return parsePluginZip(new File([blob], `${id}.lfplugin`));
  }

  it('source=local → writePluginFiles（非草稿，含 manifest.json）', async () => {
    const result = await makeZipResult('local', 'myplugin');
    const { id, source, upgraded } = await materializeZipPlugin(result, ['other']);
    expect(source).toBe('local');
    expect(id).toBe('myplugin');
    expect(upgraded).toBe(false);
    expect(writePluginFilesMock).toHaveBeenCalledTimes(1);
    expect(saveDraftPluginMock).not.toHaveBeenCalled();
    const [, files] = writePluginFilesMock.mock.calls[0];
    expect(files.some((f: { path: string }) => f.path === 'manifest.json')).toBe(true);
    expect(files.some((f: { path: string }) => f.path === 'main.py')).toBe(true);
  });

  it('source=draft → saveDraftPlugin（draft 落点）', async () => {
    const result = await makeZipResult('draft', 'mydraft');
    const { id, source } = await materializeZipPlugin(result, []);
    expect(source).toBe('draft');
    expect(id).toBe('mydraft');
    expect(saveDraftPluginMock).toHaveBeenCalledTimes(1);
    expect(writePluginFilesMock).not.toHaveBeenCalled();
    const args = saveDraftPluginMock.mock.calls[0][0];
    expect(args.id).toBe('mydraft');
    // draft 标记由 saveDraftPlugin 内部强制写入（manifest 输入不预设 draft）。
    expect(args.files.length).toBeGreaterThan(0);
  });

  it('id 冲突时 dedupe 追加 -2（不覆盖现有插件）', async () => {
    const result = await makeZipResult('local', 'taken');
    const { id, upgraded } = await materializeZipPlugin(result, ['taken']);
    expect(id).toBe('taken-2');
    expect(upgraded).toBe(false);
  });

  it('高版本包覆盖升级同 id 插件（不 dedupe，upgraded:true）', async () => {
    // 现有插件 taken v0.0.1；导入包 v0.0.2 → 覆盖原 id，不改名。
    const result = await makeZipResult('local', 'taken', '0.0.2');
    const { id, upgraded } = await materializeZipPlugin(result, ['taken'], { taken: '0.0.1' });
    expect(id).toBe('taken'); // 覆盖，不 dedupe
    expect(upgraded).toBe(true);
    expect(writePluginFilesMock).toHaveBeenCalledWith('taken', expect.any(Array));
  });

  it('同版本/低版本不触发升级（走 dedupe 改名）', async () => {
    // 现有 v0.0.2；导入包 v0.0.2（同版本）→ dedupe 改名，upgraded:false。
    const sameVersion = await makeZipResult('local', 'taken', '0.0.2');
    const r1 = await materializeZipPlugin(sameVersion, ['taken'], { taken: '0.0.2' });
    expect(r1.id).toBe('taken-2');
    expect(r1.upgraded).toBe(false);

    // 现有 v0.0.3；导入包 v0.0.2（低版本）→ dedupe 改名，upgraded:false。
    const lowerVersion = await makeZipResult('local', 'taken', '0.0.2');
    const r2 = await materializeZipPlugin(lowerVersion, ['taken'], { taken: '0.0.3' });
    expect(r2.id).toBe('taken-2');
    expect(r2.upgraded).toBe(false);
  });
});

describe('parsePluginZip 错误处理', () => {
  it('旧 JSON v1 格式 → 报旧版引导', async () => {
    const legacy = JSON.stringify({ format: 'lingfang-plugin-bundle', version: 1, manifest: {}, files: [] });
    await expect(parsePluginZip(new File([legacy], 'old.lfplugin'))).rejects.toThrow(/旧版 JSON 格式/);
  });

  it('非 ZIP 文本 → 报缺少 _meta.json', async () => {
    await expect(parsePluginZip(new File(['hello world'], 'bad.lfplugin'))).rejects.toThrow(/不是有效的 ZIP|缺少 _meta\.json/);
  });

  it('缺 _meta.json 的 ZIP → 报缺少 _meta.json', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'x', name: 'x' }));
    const blob = await zip.generateAsync({ type: 'blob' });
    await expect(parsePluginZip(new File([blob], 'x.lfplugin'))).rejects.toThrow(/缺少 _meta\.json/);
  });

  it('version 不为 2 → 报版本不受支持', async () => {
    const zip = new JSZip();
    zip.file('_meta.json', JSON.stringify({ format: 'lingfang-plugin', version: 99, source: 'local', exportedAt: 'now', name: 'x' }));
    zip.file('manifest.json', JSON.stringify({ id: 'x', name: 'x' }));
    const blob = await zip.generateAsync({ type: 'blob' });
    await expect(parsePluginZip(new File([blob], 'x.lfplugin'))).rejects.toThrow(/版本.*不受支持/);
  });

  it('缺 manifest.json → 报缺 manifest', async () => {
    const zip = new JSZip();
    zip.file('_meta.json', JSON.stringify({ format: 'lingfang-plugin', version: 2, source: 'local', exportedAt: 'now', name: 'x' }));
    const blob = await zip.generateAsync({ type: 'blob' });
    await expect(parsePluginZip(new File([blob], 'x.lfplugin'))).rejects.toThrow(/缺少 manifest\.json/);
  });
});
