import { describe, expect, it, vi } from 'vitest';
import { installMarketplacePluginPackage } from './plugin-installation';
import type { LoadedPlugin } from './types';

const files = [
  { path: 'manifest.json', content: '{"id":"tool","name":"Tool","entry":"main.py","runtime_type":"python"}' },
  { path: 'main.py', content: 'print("ok")' },
  { path: 'requirements.txt', content: 'requests==2.32.3' },
];

function plugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id: 'plugin-1',
    name: 'Tool',
    version: '1.0.0',
    entry: 'main.py',
    runtime_type: 'python',
    source: 'marketplace',
    files,
    ...overrides,
  };
}

describe('installMarketplacePluginPackage', () => {
  it('安装市场插件后从 available 读取包文件并写入本地持久化目录', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ status: 'installed' })
      .mockResolvedValueOnce({ plugins: [plugin()] });
    const writePluginFiles = vi.fn().mockResolvedValue(undefined);

    const installed = await installMarketplacePluginPackage('plugin-1', { api, writePluginFiles });

    expect(installed.id).toBe('plugin-1');
    expect(api).toHaveBeenNthCalledWith(1, '/api/marketplace/install', {
      method: 'POST',
      body: { plugin_id: 'plugin-1' },
    });
    expect(api).toHaveBeenNthCalledWith(2, '/api/plugins/available');
    expect(writePluginFiles).toHaveBeenCalledWith('plugin-1', files);
  });

  it('available 未返回 files 时显式失败，避免空目录被误认为安装成功', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ status: 'installed' })
      .mockResolvedValueOnce({ plugins: [plugin({ files: undefined })] });
    const writePluginFiles = vi.fn().mockResolvedValue(undefined);

    await expect(installMarketplacePluginPackage('plugin-1', { api, writePluginFiles }))
      .rejects.toThrow('未返回插件文件');
    expect(writePluginFiles).not.toHaveBeenCalled();
  });

  it('只有 manifest 没有入口文件时显式失败', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ status: 'installed' })
      .mockResolvedValueOnce({
        plugins: [plugin({
          manifest: { id: 'tool', name: 'Tool', entry: 'main.py', runtime_type: 'python' },
          files: [],
        })],
      });
    const writePluginFiles = vi.fn().mockResolvedValue(undefined);

    await expect(installMarketplacePluginPackage('plugin-1', { api, writePluginFiles }))
      .rejects.toThrow('未返回插件文件');
    expect(writePluginFiles).not.toHaveBeenCalled();
  });

  it('落盘时用云端 manifest 生成 manifest.json，避免 files 缺 manifest 后本地扫描未完成', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ status: 'installed' })
      .mockResolvedValueOnce({
        plugins: [plugin({
          manifest: { id: 'tool', name: 'Tool', entry: 'main.py', runtime_type: 'python' },
          files: files.filter((file) => file.path !== 'manifest.json'),
        })],
      });
    const writePluginFiles = vi.fn().mockResolvedValue(undefined);

    await installMarketplacePluginPackage('plugin-1', { api, writePluginFiles });

    const writtenFiles = writePluginFiles.mock.calls[0][1];
    expect(writtenFiles[0].path).toBe('manifest.json');
    expect(JSON.parse(writtenFiles[0].content)).toMatchObject({
      id: 'tool',
      name: 'Tool',
      entry: 'main.py',
      runtime_type: 'python',
    });
    expect(writtenFiles.map((file: { path: string }) => file.path)).toContain('main.py');
  });

  it('files 与 manifest 都缺 manifest.json 时显式失败', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ status: 'installed' })
      .mockResolvedValueOnce({
        plugins: [plugin({ files: files.filter((file) => file.path !== 'manifest.json') })],
      });
    const writePluginFiles = vi.fn().mockResolvedValue(undefined);

    await expect(installMarketplacePluginPackage('plugin-1', { api, writePluginFiles }))
      .rejects.toThrow('未返回 manifest.json');
    expect(writePluginFiles).not.toHaveBeenCalled();
  });
});
