// 落地页根：未登录时的「官网首页」。
// 深色作用域（.landing-scope）隔离自管理后台的浅色 shadcn 主题。
// 登录、下载、更新日志均已独立为各自全屏页，由 App.tsx 的状态机切换；此处仅渲染首页 sections。
import './landing.css';
import { LandingNav } from './LandingNav';
import { LandingHero } from './LandingHero';
import { LandingFeatures } from './LandingFeatures';
import { LandingArchitecture } from './LandingArchitecture';
import { LandingFooter } from './LandingFooter';

interface LandingProps {
  onLogin: () => void;
  onNavigateDownload: () => void;
  onNavigateChangelog: () => void;
}

export function Landing({ onLogin, onNavigateDownload, onNavigateChangelog }: LandingProps) {
  return (
    <div className="landing-scope lf-noise">
      <div className="lf-grid-bg" />
      <div className="lf-glow" />
      <div className="lf-content">
        <LandingNav
          onLogin={onLogin}
          onNavigateDownload={onNavigateDownload}
          onNavigateChangelog={onNavigateChangelog}
        />
        <main>
          <LandingHero
            onLogin={onLogin}
            onNavigateDownload={onNavigateDownload}
            onNavigateChangelog={onNavigateChangelog}
          />
          <LandingFeatures />
          <LandingArchitecture />
          <LandingFooter
            onNavigateDownload={onNavigateDownload}
            onNavigateChangelog={onNavigateChangelog}
          />
        </main>
      </div>
    </div>
  );
}
