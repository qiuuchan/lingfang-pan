import { describe, expect, it } from 'vitest';
import { buildChatOutputItems, type ChatSegment, type ChatTurn } from './chat-output-model';

describe('buildChatOutputItems', () => {
  it('把思考、回复、工具调用拆成独立输出项，并让思考默认折叠', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: '做一个番茄钟' }];
    const segments: ChatSegment[] = [
      { stream: 'thought', text: '分析需求。' },
      { stream: 'stdout', text: '我会先创建界面。' },
      { stream: 'tool', text: 'Write {"path":"ui/index.html"}' },
    ];

    const items = buildChatOutputItems(turns, segments, true);

    expect(items.map((item) => item.type)).toEqual(['user', 'reasoning', 'assistant-text', 'tool']);
    expect(items[1]).toMatchObject({ type: 'reasoning', text: '分析需求。', defaultOpen: false });
    expect(items[2]).toMatchObject({ type: 'assistant-text', text: '我会先创建界面。', live: true });
    expect(items[3]).toMatchObject({ type: 'tool', name: 'Write', argsText: '{"path":"ui/index.html"}' });
  });

  it('结束后用最终 assistant turn 替换 live stdout，避免回复重复', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！我可以帮你创建插件。' },
    ];
    const segments: ChatSegment[] = [
      { stream: 'thought', text: '判断这是闲聊。' },
      { stream: 'stdout', text: '你好！' },
      { stream: 'tool', text: 'Read {"path":"README.md"}' },
    ];

    const items = buildChatOutputItems(turns, segments, false);

    expect(items.map((item) => item.type)).toEqual(['user', 'reasoning', 'assistant-text', 'tool']);
    expect(items.filter((item) => item.type === 'assistant-text')).toHaveLength(1);
    expect(items[2]).toMatchObject({ type: 'assistant-text', text: '你好！我可以帮你创建插件。', live: false });
  });

  it('流式中有 pending user 时保留上一轮 assistant 回复', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ];
    const segments: ChatSegment[] = [{ stream: 'thought', text: '继续分析。' }];

    const items = buildChatOutputItems(turns, segments, true);

    expect(items.map((item) => item.type)).toEqual(['user', 'assistant-text', 'user', 'reasoning']);
    expect(items[1]).toMatchObject({ type: 'assistant-text', text: '第一答', live: false });
  });

  it('收尾批处理未清 pending user 时去掉重复提问和重复回复', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二答' },
      { role: 'user', content: '第二问' },
    ];
    const segments: ChatSegment[] = [
      { stream: 'thought', text: '继续处理。' },
      { stream: 'stdout', text: '第二答' },
    ];

    const items = buildChatOutputItems(turns, segments, true);

    expect(items.map((item) => item.type)).toEqual(['user', 'assistant-text', 'user', 'reasoning', 'assistant-text']);
    expect(items.filter((item) => item.type === 'user' && item.text === '第二问')).toHaveLength(1);
    expect(items.filter((item) => item.type === 'assistant-text' && item.text === '第二答')).toHaveLength(1);
  });

  it('多个工具调用分别成为独立输出项', () => {
    const segments: ChatSegment[] = [
      { stream: 'stdout', text: '我会检查并写入文件。' },
      { stream: 'tool', text: 'Read {"path":"README.md"}' },
      { stream: 'tool', text: 'Write {"path":"ui/index.html"}' },
    ];

    const items = buildChatOutputItems([], segments, true);

    expect(items.map((item) => item.type)).toEqual(['assistant-text', 'tool', 'tool']);
    expect(items[1]).toMatchObject({ type: 'tool', name: 'Read' });
    expect(items[2]).toMatchObject({ type: 'tool', name: 'Write' });
  });

  it('结束后的 assistant turn 可以携带 segments，思考和工具不会收尾丢失', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: '做一个图片工具' },
      {
        role: 'assistant',
        content: '图片工具已生成。',
        segments: [
          { stream: 'thought', text: '先确认 PySide6 结构。' },
          { stream: 'stdout', text: '图片工具已生成。' },
          { stream: 'tool', text: 'Write {"path":"main.py"}' },
        ],
      },
    ];

    const items = buildChatOutputItems(turns, [], false);

    expect(items.map((item) => item.type)).toEqual(['user', 'reasoning', 'assistant-text', 'tool']);
    expect(items[1]).toMatchObject({ type: 'reasoning', text: '先确认 PySide6 结构。', live: false });
    expect(items[2]).toMatchObject({ type: 'assistant-text', text: '图片工具已生成。', live: false });
    expect(items[3]).toMatchObject({ type: 'tool', name: 'Write' });
  });

  it('把高密度执行日志拆成多条进度项，避免整轮输出挤成一坨', () => {
    const segments: ChatSegment[] = [
      {
        stream: 'stdout',
        text: '现在写配置与常量模块：配置模块完成。现在写持久化层：持久化层完成。现在写 API 客户端模块：API 客户端完成。',
      },
    ];

    const items = buildChatOutputItems([], segments, true);

    expect(items.map((item) => item.type)).toEqual([
      'progress',
      'progress',
      'progress',
      'progress',
      'progress',
      'progress',
    ]);
    expect(items[0]).toMatchObject({ type: 'progress', title: '现在写配置与常量模块', status: 'running' });
    expect(items[1]).toMatchObject({ type: 'progress', title: '配置模块完成', status: 'done' });
    expect(items[2]).toMatchObject({ type: 'progress', title: '现在写持久化层', status: 'running' });
  });
});
