import { describe, it, expect } from 'vitest';
import { filesToStagedPlugin, type ImportResult } from './import-local';

function result(files: { path: string; content: string }[], rootName = 'my-plugin'): ImportResult {
  return { files, skipped: [], rootName };
}

describe('filesToStagedPlugin', () => {
  it('用 manifest.json 字段填充草稿（title 优先于 name）', () => {
    const manifest = JSON.stringify({
      id: 'cool-tool', name: 'cool-tool', title: '酷工具', version: '2.1.0',
      description: '很酷', runtime_type: 'client', entry: 'ui/index.html', visibility: 'private',
      capabilities: [{ kind: 'llm.chat', reason: '问答', risk: 'low' }],
    });
    const draft = filesToStagedPlugin(result([
      { path: 'manifest.json', content: manifest },
      { path: 'ui/index.html', content: '<h1>hi</h1>' },
    ]));
    expect(draft.id).toBe('cool-tool');
    expect(draft.name).toBe('酷工具');
    expect(draft.version).toBe('2.1.0');
    expect(draft.runtime_type).toBe('client');
    expect(draft.entry).toBe('ui/index.html');
    expect(draft.visibility).toBe('private');
    expect(draft.capabilities[0].kind).toBe('llm.chat');
  });

  it('无 manifest：按 main.py 启发式判 python，id 用根目录名收敛', () => {
    const draft = filesToStagedPlugin(result([
      { path: 'main.py', content: 'print(1)' },
      { path: 'requirements.txt', content: '' },
    ], 'My Plugin 名'));
    expect(draft.runtime_type).toBe('python');
    expect(draft.entry).toBe('main.py');
    // safePluginId 收敛非 ASCII：含中文段转码，结果为合法 kebab。
    expect(draft.id).toMatch(/^[a-z0-9_-]+$/);
    expect(draft.capabilities[0].kind).toBe('ui.view'); // 无 manifest 默认能力
  });

  it('无 manifest：按 index.js 启发式判 nodejs', () => {
    const draft = filesToStagedPlugin(result([
      { path: 'index.js', content: 'console.log(1)' },
      { path: 'package.json', content: '{}' },
    ]));
    expect(draft.runtime_type).toBe('nodejs');
    expect(draft.entry).toBe('index.js');
  });

  it('入口不存在时回退到存在的 html 文件，保证 entry∈files', () => {
    const draft = filesToStagedPlugin(result([
      { path: 'app.html', content: '<p>x</p>' },
    ]));
    expect(draft.runtime_type).toBe('client');
    expect(draft.files.some((f) => f.path === draft.entry)).toBe(true);
  });

  it('入口和文件都没匹配时回退到第一个文件', () => {
    const draft = filesToStagedPlugin(result([
      { path: 'readme.md', content: '# x' },
    ]));
    expect(draft.files.some((f) => f.path === draft.entry)).toBe(true);
  });
});
