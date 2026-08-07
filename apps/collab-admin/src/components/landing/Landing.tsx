// 落地页根：未登录时的「官网首页」。
// 纸稿/朱砂印主题（.landing-scope）隔离自管理后台的 shadcn 主题。
// section 顺序：Hero → Features → Topology → Footer。
import './landing.css';
import { LandingNav } from './LandingNav';
import { LandingHero } from './LandingHero';
import { LandingFeatures } from './LandingFeatures';
import { LandingWorkflow } from './LandingWorkflow';
import { LandingCTA } from './LandingCTA';
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
          <LandingWorkflow />
          <LandingCTA onLogin={onLogin} onNavigateDownload={onNavigateDownload} />
          <LandingFooter
            onNavigateDownload={onNavigateDownload}
            onNavigateChangelog={onNavigateChangelog}
          />
        </main>
      </div>
    </div>
  );
}
