// Markdown 渲染（落地页更新日志 / 下载页 release notes 共用）。
// 扩展版：支持代码块 fence、标题、有序/无序列表、引用、分隔线、表格、段落、行内元素。
// 不引 react-markdown（+40KB gzip），手写覆盖 95% release notes 场景。
// 支持语法：# / ## / ### / #### 标题、- / * 无序列表、1. / 2. 有序列表、
//          > 引用、--- 分隔线、```代码块```、| 表格 |、**bold**、`code`、![img](url)、[link](url)。
import type { ReactNode } from 'react';

/** 行内元素解析：**bold**、`code`、![alt](url) 图片、[text](url) 链接、~~删除线~~。
 *  图片必须在链接前匹配（!\[ 前缀优先于 \[），否则图片会被当链接解析错。 */
export function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  // 顺序：图片 → 链接 → bold → 删除线 → code。
  const regex = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|~~([^~]+)~~|`([^`]+)`/g;
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
      // 粗体
      parts.push(
        <strong key={key++} className="font-semibold" style={{ color: 'var(--lf-fg)' }}>
          {match[0].slice(2, -2)}
        </strong>,
      );
    } else if (match[0].startsWith('~~')) {
      // 删除线
      parts.push(
        <del key={key++} className="opacity-60">
          {match[0].slice(2, -2)}
        </del>,
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

/** 解析表格行（| a | b | 格式），返回单元格数组（去首尾空 + 去 |）。 */
function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** 判断是否为表格分隔行（| --- | --- | 格式）。 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?[\s-:]+(\|[\s-:]+)+\|?$/.test(trimmed) && trimmed.includes('-');
}

/** 块级渲染：支持代码块/标题/列表/引用/分隔线/表格/段落。
 *  返回 ReactNode 数组供组件直接渲染。 */
export function renderMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行跳过。
    if (trimmed.length === 0) {
      i++;
      continue;
    }

    // 代码块 fence（``` 或 ~~~）。
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[0].repeat(3))) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 fence。
      nodes.push(
        <pre
          key={key++}
          className="lf-mono my-3 overflow-x-auto rounded-lg p-4 text-xs leading-relaxed"
          style={{
            backgroundColor: 'var(--lf-bg-elevated)',
            border: '1px solid var(--lf-border)',
            color: 'var(--lf-fg)',
          }}
        >
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    // 标题：# / ## / ### / ####。
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const sizeCls =
        level === 1
          ? 'text-xl font-bold mt-5 mb-2'
          : level === 2
            ? 'text-lg font-semibold mt-4 mb-1.5'
            : level === 3
              ? 'text-base font-semibold mt-3 mb-1'
              : 'text-sm font-semibold mt-2 mb-1';
      const HeadingTag = (`h${Math.min(level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6');
      nodes.push(
        <HeadingTag key={key++} className={sizeCls} style={{ color: 'var(--lf-fg)' }}>
          {renderInline(heading[2])}
        </HeadingTag>,
      );
      i++;
      continue;
    }

    // 分隔线
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      nodes.push(<hr key={key++} className="my-4 border-t" style={{ borderColor: 'var(--lf-border)' }} />);
      i++;
      continue;
    }

    // 表格检测（当前行含 | + 下一行是分隔行）。
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = parseTableRow(trimmed);
      i += 2; // 跳过表头 + 分隔行。
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim().length > 0) {
        bodyRows.push(parseTableRow(lines[i]));
        i++;
      }
      nodes.push(
        <div key={key++} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {headerCells.map((cell, ci) => (
                  <th
                    key={ci}
                    className="border px-3 py-2 text-left font-semibold"
                    style={{ borderColor: 'var(--lf-border-bright)', color: 'var(--lf-fg)' }}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="border px-3 py-1.5"
                      style={{ borderColor: 'var(--lf-border)', color: 'var(--lf-fg-muted)' }}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 有序列表项：1. / 2. / 3.
    const orderedMatch = /^(\d+)\.\s+(.*)$/.exec(trimmed);
    if (orderedMatch) {
      const items: { num: string; content: string; indent: number }[] = [];
      while (i < lines.length) {
        const m = /^(\d+)\.\s+(.*)$/.exec(lines[i].trim());
        if (m) {
          const indent = lines[i].length - lines[i].trimStart().length;
          items.push({ num: m[1], content: m[2], indent });
          i++;
        } else if (lines[i].trim().length === 0) {
          i++;
          break;
        } else {
          break;
        }
      }
      nodes.push(
        <ol key={key++} className="my-2 space-y-1 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
          {items.map((item, idx) => (
            <li
              key={idx}
              className="flex gap-2.5"
              style={{ paddingLeft: `${item.indent * 0.5}rem` }}
            >
              <span className="lf-mono shrink-0 font-semibold" style={{ color: 'var(--lf-accent)' }}>
                {item.num}.
              </span>
              <span>{renderInline(item.content)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // 无序列表项：- 或 *
    if (/^[-*]\s+/.test(trimmed)) {
      const items: { content: string; indent: number }[] = [];
      while (i < lines.length) {
        const m = /^[-*]\s+(.*)$/.exec(lines[i].trim());
        if (m) {
          const indent = lines[i].length - lines[i].trimStart().length;
          items.push({ content: m[1], indent });
          i++;
        } else if (lines[i].trim().length === 0) {
          i++;
          break;
        } else {
          break;
        }
      }
      nodes.push(
        <ul key={key++} className="my-2 space-y-1 text-sm" style={{ color: 'var(--lf-fg-muted)' }}>
          {items.map((item, idx) => (
            <li
              key={idx}
              className="flex gap-2.5"
              style={{ paddingLeft: `${item.indent * 0.5}rem` }}
            >
              <span className="mt-0.5 shrink-0" style={{ color: 'var(--lf-accent)' }}>
                ›
              </span>
              <span>{renderInline(item.content)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 引用
    if (trimmed.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quoteLines.push(lines[i].trim().slice(2));
        i++;
      }
      nodes.push(
        <blockquote
          key={key++}
          className="my-3 border-l-2 pl-4 py-1 text-sm italic"
          style={{ borderColor: 'var(--lf-accent)', color: 'var(--lf-fg-subtle)' }}
        >
          {quoteLines.map((q, qi) => (
            <p key={qi} className="leading-relaxed">
              {renderInline(q)}
            </p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // 普通段落
    nodes.push(
      <p key={key++} className="my-1.5 text-sm leading-relaxed" style={{ color: 'var(--lf-fg-muted)' }}>
        {renderInline(trimmed)}
      </p>,
    );
    i++;
  }

  return nodes;
}
