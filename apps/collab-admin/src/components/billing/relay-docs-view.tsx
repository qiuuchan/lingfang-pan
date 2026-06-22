// 接入文档视图：渲染后端返回的 markdown。见 docs/billing-and-relay-design.md §11.5.1 ⑦。
import { useState } from 'react';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/helpers';
import { Section } from '@/components/shared';
import { renderMarkdown } from '@/lib/markdown';

export function RelayDocsView() {
  const [md, setMd] = useState('');
  useLoad(async () => {
    const r = await api<{ markdown: string }>('/api/admin/billing/relay-docs');
    setMd(r.markdown);
  });
  return (
    <Section title="接入文档" description="AI 插件开发者接入指引（base url、鉴权、版本、计费、错误码、SDK 示例）。">
      <div className="prose prose-sm max-w-none dark:prose-invert">{renderMarkdown(md)}</div>
    </Section>
  );
}
