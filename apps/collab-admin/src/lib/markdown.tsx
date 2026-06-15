// 极简 markdown 渲染（落地页更新日志 / 下载页 release notes 共用）。
// 不引 react-markdown 等重型库（+40KB gzip 落地页首屏变大），用正则覆盖 80% 场景。
// 支持：# / ## / ### 标题、- / * 列表（保留缩进）、> 引用、--- 分隔线、空行段落分隔、
//       **bold**、`code`、![alt](url) 图片、[text](url) 链接。
// 不支持：多行代码块 fence（```），标注「release notes 不建议贴代码块」。
import type { ReactNode } from 'react';

/** 行内元素解析：**bold**、`code`、![alt](url) 图片、[text](url) 链接。
 *  图片必须在链接前匹配（!\[ 前缀优先于 \[），否则图片会被当链接解析错。 */
export function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  // 顺序：图片 → 链接 → bold → code。
  const regex = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[0].startsWith('![')) {
      // 图片
      parts.push(
        <img
          key={key++}
          src={match[2]}
          alt={match[1]}
          className="my-2 max-w-full rounded-md border"
          style={{ borderColor: 'var(--lf-border)' }}
          loading="lazy"
        />,
      );
    } else if (match[0].startsWith('[')) {
      // 链接
      parts.push(
        <a
          key={key++}
          href={match[4]}
          target="_blank"
          rel="noopener noreferrer"
          className="underline transition-colors hover:opacity-80"
          style={{ color: 'var(--lf-accent)' }}
        >
          {match[3]}
        </a>,
      );
    } else if (match[0].startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold" style={{ color: 'var(--lf-fg)' }}>
          {match[0].slice(2, -2)}
        </strong>,
      );
    } else {
      // 行内 code
      parts.push(
        <code
          key={key++}
          className="lf-mono rounded px-1.5 py-0.5 text-[0.85em]"
          style={{ backgroundColor: 'var(--lf-bg-elevated)', color: 'var(--lf-accent)' }}
        >
          {match[0].slice(1, -1)}
        </code>,
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

/** 块级渲染：支持 #/##/###、-/* 列表（保留缩进）、> 引用、--- 分隔线、空行段落分隔。
 *  多行代码块 fence ``` 不解析（当普通段落）。返回 ReactNode 数组供组件直接渲染。 */
export function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split('\n');
  const nodes: ReactNode[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // 保留空行做段落分隔（不渲染节点）。
    if (trimmed.length === 0) return;
    // 标题：# / ## / ###。
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const sizeCls = level === 1 ? 'text-lg' : level === 2 ? 'text-base' : 'text-sm';
      nodes.push(
        <h4 key={i} className={`lf-mono ${sizeCls} font-semibold mt-3 first:mt-0`} style={{ color: 'var(--lf-fg)' }}>
          {renderInline(heading[2])}
        </h4>,
      );
      return;
    }
    // 分隔线
    if (trimmed === '---' || trimmed === '***') {
      nodes.push(<hr key={i} className="my-3 border-t" style={{ borderColor: 'var(--lf-border)' }} />);
      return;
    }
    // 列表项：- 或 *（保留缩进表达层级，避免塌平）。
    if (/^[-*]\s+/.test(trimmed)) {
      const indent = line.length - line.trimStart().length;
      nodes.push(
        <div
          key={i}
          className="flex gap-2 text-sm"
          style={{ color: 'var(--lf-fg-muted)', paddingLeft: `${indent * 0.5}rem` }}
        >
          <span style={{ color: 'var(--lf-accent)' }}>›</span>
          <span>{renderInline(trimmed.replace(/^[-*]\s+/, ''))}</span>
        </div>,
      );
      return;
    }
    // 引用
    if (trimmed.startsWith('> ')) {
      nodes.push(
        <blockquote
          key={i}
          className="border-l-2 pl-3 text-xs italic"
          style={{ borderColor: 'var(--lf-border-bright)', color: 'var(--lf-fg-subtle)' }}
        >
          {renderInline(trimmed.slice(2))}
        </blockquote>,
      );
      return;
    }
    // 普通段落
    nodes.push(
      <p key={i} className="text-sm leading-relaxed" style={{ color: 'var(--lf-fg-muted)' }}>
        {renderInline(trimmed)}
      </p>,
    );
  });
  return nodes;
}
