import pkg from '../../package.json';

const YEAR = 2026;
// 兜底：package.json 版本（拉取失败/未配置时展示）。
const APP_VERSION = pkg.version || '0.0.0';

interface FooterProps {
  /** 版本号，默认取 package.json 的版本；测试或特殊场景可覆盖。 */
  version?: string;
}

export function Footer({ version = APP_VERSION }: FooterProps) {
  return (
    <footer className="flex flex-col items-center justify-between gap-2 border-t py-4 text-xs text-muted-foreground sm:flex-row">
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
