// 管理端后台主内容区页脚：版权 + 版本 + 链接（文档/官网）。
// 仅渲染于 App.tsx 主内容区底部，随主内容滚到底可见，不做全局 fixed。
import pkg from '../../package.json';

const YEAR = 2026;
// 版本取自 package.json（resolveJsonModule 已开启），与 About 对话框一致。
const APP_VERSION = pkg.version || '0.0.0';

interface FooterProps {
  /** 版本号，默认取 package.json 的版本；测试或特殊场景可覆盖。 */
  version?: string;
}

export function Footer({ version = APP_VERSION }: FooterProps) {
  return (
    <footer className="mt-8 flex flex-col items-center justify-between gap-2 border-t py-4 text-xs text-muted-foreground sm:flex-row">
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
    </footer>
  );
}
