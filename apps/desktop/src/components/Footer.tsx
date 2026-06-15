// 桌面应用主内容区页脚：版权 + 版本 + 链接（文档/官网）。
// 作为 App.tsx 主体区 flex-col 的最后一个子元素（shrink-0），固定在视口底部，不随主内容滚动。
// flex 布局下无需 mt-8（内容区已 flex-1 占满剩余空间，Footer 自然贴底）。
import pkg from '../../package.json';

const YEAR = 2026;
// 版本取自 package.json（resolveJsonModule 已开启），与 collab-admin 的 About 对话框一致。
const APP_VERSION = pkg.version || '0.0.0';

interface FooterProps {
  /** 版本号，默认取 package.json 的版本；测试或特殊场景可覆盖。 */
  version?: string;
}

export function Footer({ version = APP_VERSION }: FooterProps) {
  return (
    <footer className="shrink-0 border-t border-border/60 px-6 py-4 text-xs text-muted-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 sm:flex-row">
        <p>© {YEAR} LingFang</p>
        <div className="flex items-center gap-4">
          <span className="font-mono">v{version}</span>
          <a
            href="https://lingfang.io/docs"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            文档
          </a>
          <a
            href="https://lingfang.io"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            官网
          </a>
        </div>
      </div>
    </footer>
  );
}
