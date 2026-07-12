import { describe, it, expect } from 'vitest';
import { filesToStagedPlugin, MAX_SOURCE_FILES, readLocalFiles, type ImportResult } from './import-local';

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
    expect(draft.sourceKind).toBe('EXTERNAL_TOOL');
    expect(draft.sourceLabel).toBe('外部开发工具');
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

  it('保留 contract 支持的 cloud runtime，不改写为 client', () => {
    const draft = filesToStagedPlugin(result([
      {
        path: 'manifest.json',
        content: JSON.stringify({
          id: 'cloud-demo',
          name: 'Cloud Demo',
          version: '1.0.0',
          description: '',
          runtime_type: 'cloud',
          entry: 'ui/index.html',
          visibility: 'tenant',
          capabilities: [{ kind: 'ui.view' }],
        }),
      },
      { path: 'ui/index.html', content: '<main>cloud</main>' },
    ]));

    expect(draft.runtime_type).toBe('cloud');
    expect(draft.entry).toBe('ui/index.html');
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

function localFile(relativePath: string, content: string | Uint8Array): File {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const segments = relativePath.split('/');
  return {
    name: segments[segments.length - 1] || relativePath,
    size: bytes.byteLength,
    webkitRelativePath: relativePath,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

describe('readLocalFiles', () => {
  it('为 v4 的两个固定元数据条目预留容量，并只跳过超出的源码文件', async () => {
    expect(MAX_SOURCE_FILES).toBe(1498);
    const files = Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, index) => (
      localFile(`plugin/src/file-${index}.txt`, 'x')
    ));

    const imported = await readLocalFiles(files);

    expect(imported.files).toHaveLength(MAX_SOURCE_FILES);
    expect(imported.skipped).toEqual([
      `src/file-${MAX_SOURCE_FILES}.txt（超 ${MAX_SOURCE_FILES} 个源码文件上限；v4 制品 1500 条目含 2 个固定元数据文件）`,
    ]);
  });

  it('保留 dist/build 真实产物，仍排除依赖和缓存目录', async () => {
    const imported = await readLocalFiles([
      localFile('plugin/dist/index.js', 'console.log("dist")'),
      localFile('plugin/build/assets/logo.png', new Uint8Array([0, 255, 3, 4])),
      localFile('plugin/node_modules/pkg/index.js', 'ignored'),
      localFile('plugin/.git/config', 'ignored'),
    ]);

    expect(imported.files.map((file) => file.path)).toEqual([
      'dist/index.js',
      'build/assets/logo.png',
    ]);
    expect(imported.files[1]).toMatchObject({ binary: true, content: 'AP8DBA==' });
  });

  it('文本扩展名包含非法 UTF-8 时按二进制保留原字节', async () => {
    const imported = await readLocalFiles([
      localFile('plugin/src/legacy.txt', new Uint8Array([0xff, 0xfe, 0x41])),
    ]);

    expect(imported.files).toEqual([
      { path: 'src/legacy.txt', content: '//5B', binary: true },
    ]);
  });

  it('有效 UTF-8 BOM 作为文本往返时不丢失', async () => {
    const imported = await readLocalFiles([
      localFile('plugin/src/bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
    ]);

    const content = imported.files[0]?.content ?? '';
    expect(imported.files[0]?.binary).toBeUndefined();
    expect(Array.from(new TextEncoder().encode(content))).toEqual([0xef, 0xbb, 0xbf, 0x41]);
  });
});
