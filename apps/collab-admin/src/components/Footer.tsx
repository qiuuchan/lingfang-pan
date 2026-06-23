// 管理端后台主内容区页脚：版权 + 版本 + 链接（文档/官网）。
// 版本号取自 Gitee 更新日志源（/api/changelog，后端用 giteeAccessToken 拉取验证）的最新 tag，
// 与页脚「最后提交版本」语义一致，替代旧的构建时 git hash（无 git 环境会显示 unknown）。
import { useEffect, useState } from 'react';
import pkg from '../../package.json';
import { listChangelog } from '@/lib/releases';

const YEAR = 2026;
// 兜底：package.json 版本（拉取失败/未配置时展示）。
const APP_VERSION = pkg.version || '0.0.0';

interface FooterProps {
  /** 版本号，默认取 package.json 的版本；测试或特殊场景可覆盖。 */
  version?: string;
}

export function Footer({ version = APP_VERSION }: FooterProps) {
  // 从 Gitee 更新日志源拉最新版本 tag（/api/changelog 后端用 giteeAccessToken 拉取验证）。
  const [latest, setLatest] = useState<string>('');
  useEffect(() => {
    let mounted = true;
    listChangelog()
      .then((r) => { if (mounted && r.releases.length) setLatest(r.releases[0].version); })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  return (
    <footer className="shrink-0 flex flex-col items-center justify-between gap-2 border-t py-4 text-xs text-muted-foreground sm:flex-row">
      <p>© {YEAR} LingFang</p>
      <div className="flex items-center gap-4">
        <span className="font-mono">v{version}</span>
        {/* 最新发布版本（来自 Gitee 更新日志源，后端用 access token 拉取验证）。
            拉取失败/未配置时回退到 package.json 版本。 */}
        <span className="font-mono text-muted-foreground/70" title="Gitee 最新发布版本">
          {latest ? `Gitee ${latest}` : `Gitee v${version}`}
        </span>
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
