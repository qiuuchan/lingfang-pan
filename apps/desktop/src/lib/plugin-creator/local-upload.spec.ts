// local-upload.spec.ts —— loadLocalPluginAsStaged 单测：本地插件 → StagedPlugin（供上传）。
//
// 验证：读磁盘 manifest.json + list_plugin_files + 逐文件 read_local_plugin_file 组装出
// 完整 StagedPlugin（含 capabilities/visibility），二进制占位文件被跳过，manifest.json 不进 files。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted 拿到工厂内可引用的 mock 引用，再 vi.mock 替换 plugin-status（local-upload 唯一 IO 依赖）。
const readLocalFileMock = vi.hoisted(() => vi.fn());
const listPluginFilesMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/plugin-status', () => ({
  readLocalPluginFile: readLocalFileMock,
  listPluginFiles: listPluginFilesMock,
}));

import { loadLocalPluginAsStaged } from './local-upload';

const PYTHON_MANIFEST = JSON.stringify({
  id: 'videodl',
  name: 'videodl',
  title: '视频下载器',
  version: '0.1.0',
  description: '下载视频',
  runtime_type: 'python',
  entry: 'main.py',
  visibility: 'tenant',
  capabilities: [{ kind: 'ui.view', reason: 'GUI', risk: 'none', requires_admin: false }],
});

beforeEach(() => {
  readLocalFileMock.mockReset();
  listPluginFilesMock.mockReset();
});

describe('loadLocalPluginAsStaged', () => {
  it('python 插件：组装完整 StagedPlugin（title 优先 name、保留 capabilities/visibility、跳过 manifest.json）', async () => {
    listPluginFilesMock.mockResolvedValue(['manifest.json', 'main.py', 'requirements.txt']);
    readLocalFileMock.mockImplementation(async (_id: string, file: string) => {
      if (file === 'manifest.json') return PYTHON_MANIFEST;
      if (file === 'main.py') return 'print(1)';
      if (file === 'requirements.txt') return 'videofetch';
      return '';
    });

    const staged = await loadLocalPluginAsStaged('videodl');
    expect(staged.runtime_type).toBe('python');
    expect(staged.entry).toBe('main.py');
    expect(staged.visibility).toBe('tenant');
    expect(staged.name).toBe('视频下载器'); // title 优先
    expect(staged.version).toBe('0.1.0');
    expect(staged.capabilities[0].kind).toBe('ui.view');
    // manifest.json 由 buildStagedManifestContent 重新生成，故不进 files。
    expect(staged.files.some((f) => f.path === 'manifest.json')).toBe(false);
    expect(staged.files.map((f) => f.path).sort()).toEqual(['main.py', 'requirements.txt']);
  });

  it('跳过二进制占位文件（read_local_plugin_file 对非 UTF-8 返回占位）', async () => {
    const BINARY_PLACEHOLDER = '[binary file, 1024 bytes]';
    listPluginFilesMock.mockResolvedValue(['manifest.json', 'main.py', 'icon.png']);
    readLocalFileMock.mockImplementation(async (_id: string, file: string) => {
      if (file === 'manifest.json') return JSON.stringify({ id: 'p', name: 'p', runtime_type: 'python', entry: 'main.py' });
      if (file === 'main.py') return 'print(1)';
      if (file === 'icon.png') return BINARY_PLACEHOLDER;
      return '';
    });

    const staged = await loadLocalPluginAsStaged('p');
    expect(staged.files.some((f) => f.path === 'icon.png')).toBe(false);
    expect(staged.files.map((f) => f.path)).toEqual(['main.py']);
  });

  it('缺 capabilities/visibility 时走默认（ui.view / tenant）', async () => {
    listPluginFilesMock.mockResolvedValue(['manifest.json', 'ui/index.html']);
    readLocalFileMock.mockImplementation(async (_id: string, file: string) => {
      if (file === 'manifest.json') return JSON.stringify({ id: 'web', name: 'web', runtime_type: 'client', entry: 'ui/index.html' });
      return '<h1>hi</h1>';
    });

    const staged = await loadLocalPluginAsStaged('web');
    expect(staged.runtime_type).toBe('client');
    expect(staged.capabilities[0].kind).toBe('ui.view');
    expect(staged.visibility).toBe('tenant');
  });

  it('manifest 读取失败抛带提示的错误', async () => {
    listPluginFilesMock.mockResolvedValue([]);
    readLocalFileMock.mockRejectedValue(new Error('os error 2'));
    await expect(loadLocalPluginAsStaged('missing')).rejects.toThrow(/读取 manifest\.json 失败/);
  });

  it('没有可上传源文件时抛错', async () => {
    listPluginFilesMock.mockResolvedValue(['icon.png']);
    readLocalFileMock.mockImplementation(async (_id: string, file: string) => {
      if (file === 'manifest.json') return JSON.stringify({ id: 'p', name: 'p', runtime_type: 'python' });
      return '[binary file, 1024 bytes]';
    });
    await expect(loadLocalPluginAsStaged('p')).rejects.toThrow(/没有可上传的源文件/);
  });
});
