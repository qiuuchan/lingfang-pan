import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// 轻量 markdown 渲染：不依赖 typography 插件，手动给元素配 Tailwind 类。
// 用于助手气泡渲染生成摘要。
const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="my-1.5 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-1.5 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-1 text-sm font-semibold">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10">{children}</code>,
  pre: ({ children }) => <pre className="my-1.5 overflow-auto rounded-md bg-black/10 p-2.5 font-mono text-xs dark:bg-white/10">{children}</pre>,
  a: ({ children, href }) => <a href={href} className="text-primary underline underline-offset-2">{children}</a>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{children}</ReactMarkdown>
    </div>
  );
}
