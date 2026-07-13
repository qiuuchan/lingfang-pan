import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPluginAiPolicy } from './plugin-ai-policy';

function policy(files: Array<{ path: string; content: string }>, capabilities: string[] = []) {
  return checkPluginAiPolicy({
    manifest: {
      id: 'demo',
      name: 'Demo',
      capabilities: capabilities.map((kind) => ({ kind, requires_admin: true })),
    },
    files,
  });
}

async function bundledFixture(directory: string) {
  const root = resolve(process.cwd(), '../..', directory);
  const paths: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  await walk(root);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const files = await Promise.all(paths
    .filter((path) => !path.endsWith('manifest.json'))
    .map(async (path) => ({ path: relative(root, path).replaceAll('\\', '/'), content: await readFile(path, 'utf8') })));
  return { manifest, files };
}

describe('plugin AI policy', () => {
  it('accepts plugin-sdk chat and ordinary network code when capability is declared', () => {
    const result = policy([{
      path: 'ui/index.js',
      content: `const weather = await fetch('https://weather.example/api');\nawait sdk.llm.chat({ messages, model: 'fast' });`,
    }], ['llm.chat', 'net.fetch']);
    expect(result).toMatchObject({ ok: true, requiredCapabilities: ['llm.chat'] });
  });

  it('does not reject an ordinary business provider field without AI context', () => {
    const result = policy([{
      path: 'index.js',
      content: `const provider = 'weather-station';\nawait fetch('https://weather.example/forecast');`,
    }], ['net.fetch']);
    expect(result.ok).toBe(true);
  });

  it('does not treat unrelated manifest provider fields as AI configuration just because AI is declared', () => {
    const result = checkPluginAiPolicy({
      manifest: {
        id: 'demo',
        name: 'Demo',
        entry: 'index.js',
        weather: { provider: 'weather-station', endpoint: 'https://weather.example/forecast' },
        capabilities: [{ kind: 'llm.chat' }],
      },
      files: [{ path: 'index.js', content: 'await sdk.llm.chat({ messages: [] })' }],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects known model endpoints and secrets stored in arbitrary manifest string values', () => {
    const result = checkPluginAiPolicy({
      manifest: {
        id: 'demo',
        name: 'Demo',
        entry: 'index.js',
        settings: {
          callback: 'https://api.openai.com/v1/chat/completions',
          credential: 'sk-proj-abcdefghijklmnopqrstuv',
        },
      },
      files: [{ path: 'index.js', content: 'console.log("ok")' }],
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'ai.endpoint.third_party', 'ai.config.forbidden',
    ]));
  });

  it('accepts the standard OpenAI client only with both injected bridge values', () => {
    const result = policy([
      { path: 'requirements.txt', content: 'openai==2.0.0' },
      {
        path: 'main.py',
        content: [
          'import os',
          'from openai import OpenAI',
          `client = OpenAI(base_url=os.environ['LINGFANG_PLUGIN_BRIDGE_URL'] + '/v1', api_key=os.environ['LINGFANG_PLUGIN_BRIDGE_TOKEN'])`,
          `client.chat.completions.create(model='premium', messages=[])`,
        ].join('\n'),
      },
    ], ['llm.chat']);
    expect(result.ok).toBe(true);
  });

  it('allows empty missing-env defaults but rejects non-empty custom fallbacks', () => {
    const allowed = policy([{
      path: 'main.py',
      content: [
        `url = os.environ.get('LINGFANG_PLUGIN_BRIDGE_URL', '')`,
        `token = os.environ.get('LINGFANG_PLUGIN_BRIDGE_TOKEN', '')`,
      ].join('\n'),
    }]);
    expect(allowed.ok).toBe(true);
    const rejected = policy([{
      path: 'main.py',
      content: [
        `url = os.environ.get('LINGFANG_PLUGIN_BRIDGE_URL', 'https://custom.example')`,
        `token = os.environ.get('LINGFANG_PLUGIN_BRIDGE_TOKEN', '')`,
      ].join('\n'),
    }]);
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'ai.bridge.custom' }));
  });

  it('rejects a default OpenAI client even when unused bridge env names appear', () => {
    const result = policy([
      { path: 'requirements.txt', content: 'openai==2.0.0' },
      {
        path: 'main.py',
        content: [
          'from openai import OpenAI',
          `url = os.environ['LINGFANG_PLUGIN_BRIDGE_URL']`,
          `token = os.environ['LINGFANG_PLUGIN_BRIDGE_TOKEN']`,
          'client = OpenAI()',
          `client.chat.completions.create(model='fast', messages=[])`,
        ].join('\n'),
      },
    ], ['llm.chat']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ai.bridge.custom' }));
  });

  it('rejects AI SDK dependencies outside the explicit OpenAI bridge allowlist', () => {
    const result = policy([{
      path: 'package.json',
      content: JSON.stringify({ dependencies: { '@azure/openai': '^2.0.0' } }),
    }]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ai.sdk.third_party' }));
  });

  it('does not let comment markers inside strings hide following violations', () => {
    const result = policy([{
      path: 'index.js',
      content: `const marker = '/*'; const apiKey = 'sk-proj-abcdefghijklmnopqrstuv'; await sdk.llm.chat({messages:[]});`,
    }], ['llm.chat']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ai.config.forbidden' }));
  });

  it('removes real inline JS, Python and HTML comments without flagging their endpoints', () => {
    const result = policy([
      { path: 'index.js', content: `const value = 1; // https://api.openai.com/v1` },
      { path: 'main.py', content: `value = 1  # https://api.anthropic.com` },
      { path: 'ui/index.html', content: `<!-- https://api.groq.com/openai/v1 -->\n<div>ok</div>` },
    ]);
    expect(result.ok).toBe(true);
  });

  it('rejects custom bridge fallback, third-party endpoints and hardcoded secrets', () => {
    const result = policy([{
      path: 'index.js',
      content: [
        `const baseURL = process.env.LINGFANG_PLUGIN_BRIDGE_URL || 'https://api.openai.com/v1';`,
        `const apiKey = 'sk-proj-abcdefghijklmnopqrstuv';`,
      ].join('\n'),
    }], ['llm.chat']);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'ai.bridge.custom', 'ai.endpoint.third_party', 'ai.config.forbidden',
    ]));
  });

  it('rejects third-party AI dependencies and secret sinks', () => {
    const result = policy([
      { path: 'package.json', content: JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '^1.0.0' } }) },
      { path: 'index.js', content: `console.log(process.env.LINGFANG_PLUGIN_BRIDGE_TOKEN);` },
    ]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'ai.sdk.third_party', 'ai.bridge.secret_sink',
    ]));
  });

  it('requires manifest capabilities and rejects real upstream model ids', () => {
    const result = policy([{
      path: 'index.js',
      content: `await sdk.image.generate({ prompt: 'x', model: 'gpt-image-1' });`,
    }]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ai.capability.missing', capability: 'image.generate' }),
      expect.objectContaining({ code: 'ai.model.invalid' }),
    ]));
  });

  it('fails closed for unscannable executable text', () => {
    const result = checkPluginAiPolicy({
      manifest: { id: 'demo', name: 'Demo', capabilities: [] },
      files: [{ path: 'main.py', scanError: 'invalid_utf8' }],
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ai.policy.unscannable' }));
  });

  it('enforces text limits and entry text validity inside the authoritative scanner', () => {
    const oversizedDependency = checkPluginAiPolicy({
      manifest: { id: 'demo', name: 'Demo', entry: 'main.py', capabilities: [] },
      files: [
        { path: 'main.py', content: 'print(1)' },
        { path: 'requirements.txt', content: 'x'.repeat(256 * 1024 + 1) },
      ],
    });
    expect(oversizedDependency.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ai.policy.unscannable', path: 'requirements.txt',
    }));

    for (const files of [
      [{ path: 'run', content: 'print(1)', binary: true }],
      [{ path: 'run', content: 'print(1)\0' }],
      [{ path: 'other.js', content: 'console.log(1)' }],
    ]) {
      const result = checkPluginAiPolicy({
        manifest: { id: 'demo', name: 'Demo', entry: 'run', capabilities: [] },
        files,
      });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ai.policy.unscannable' }));
    }
  });

  it.each(['worker.mts', 'worker.cts'])('scans %s source files', (path) => {
    const result = checkPluginAiPolicy({
      manifest: { id: 'demo', name: 'Demo', entry: path, capabilities: [] },
      files: [{ path, content: `fetch('https://api.anthropic.com/v1/messages')` }],
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ai.endpoint.third_party' }));
  });

  it('ignores declared binary media instead of counting it as policy text', () => {
    const result = checkPluginAiPolicy({
      manifest: { id: 'demo', name: 'Demo', capabilities: [] },
      files: [{ path: 'preview.png', content: 'A'.repeat(33 * 1024 * 1024), binary: true }],
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    'apps/desktop/builtin-plugins/ai-example',
    'apps/desktop/builtin-plugins/ai-python-example',
    'plugins/ai-demo',
  ])('keeps bundled platform-AI fixture compliant: %s', async (directory) => {
    const fixture = await bundledFixture(directory);
    expect(checkPluginAiPolicy(fixture)).toMatchObject({ ok: true });
  });
});
