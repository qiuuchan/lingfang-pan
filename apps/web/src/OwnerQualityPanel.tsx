import React, { useState } from 'react';
import type { MarketplaceOwnerQuality, MarketplaceQualityReason } from '@lingfang/contract';

const REASON_LABELS: Record<MarketplaceQualityReason, string> = {
  hard_gate_failed: '当前上架、审核或安全门禁未通过',
  listing_age_insufficient: '连续上架时间不足',
  release_age_insufficient: '当前发行版观察时间不足',
  insufficient_active_teams: '近 30 天活跃团队不足',
  insufficient_observed_runs: '近 30 天可观测运行样本不足',
  failure_rate_high: '插件归因失败率过高',
  insufficient_rating_teams: '合格评分团队不足',
  average_rating_low: '平均评分未达标',
  refund_data_unavailable: '退款数据暂不可用',
  insufficient_matured_paid_orders: '成熟付费订单样本不足',
  refund_rate_high: '获批退款率过高',
  security_blocked: '存在未解决的安全问题',
  anomaly_review_required: '指标异常，等待人工复核',
  quality_blocked: '平台已暂停自动晋级',
};

export function OwnerQualityPanel({
  quality,
  onAppeal,
}: {
  quality: MarketplaceOwnerQuality;
  onAppeal: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [state, setState] = useState('');
  const snapshot = quality.snapshot;
  const metrics = snapshot?.metrics;

  async function submit() {
    const text = body.trim();
    if (!text) return;
    setState('提交中…');
    try {
      await onAppeal(text);
      setBody('');
      setState('申诉工单已创建');
    } catch (cause) {
      setState(cause instanceof Error ? cause.message : '申诉提交失败');
    }
  }

  return (
    <section className="owner-quality" aria-label="作者质量视图">
      <h2>作者质量视图</h2>
      <p>
        当前等级：
        <strong>{{ LISTED: '已上架', QUALITY: '优质', FEATURED: '精选' }[quality.tier]}</strong>
      </p>
      {!snapshot ? (
        <p>尚无质量快照，指标计算后会在此展示。</p>
      ) : (
        <>
          <dl className="quality-meta">
            <div>
              <dt>快照</dt>
              <dd>{snapshot.fact_watermark}</dd>
            </div>
            <div>
              <dt>计算时间</dt>
              <dd>{new Date(snapshot.computed_at).toLocaleString()}</dd>
            </div>
            <div>
              <dt>规则版本</dt>
              <dd>v{snapshot.policy_version}</dd>
            </div>
          </dl>
          {metrics && (
            <div className="quality-metrics">
              <Metric label="连续上架" value={`${metrics.listing_age_days} 天`} />
              <Metric label="发行版观察" value={`${metrics.current_release_age_days} 天`} />
              <Metric label="30 天活跃团队" value={metrics.active_teams_30d} />
              <Metric
                label="30 天运行"
                value={`${metrics.observed_runs_30d}（失败 ${metrics.failed_runs_30d}）`}
              />
              <Metric label="失败率" value={percent(metrics.failure_rate_bps)} />
              <Metric label="评分团队" value={metrics.rating_teams} />
              <Metric
                label="平均评分"
                value={
                  metrics.average_rating_tenths == null
                    ? '数据不足'
                    : `${(metrics.average_rating_tenths / 10).toFixed(1)} / 5`
                }
              />
              <Metric label="90 天成熟订单" value={metrics.matured_paid_orders_90d} />
              <Metric
                label="退款率"
                value={
                  metrics.refund_metric_state === 'NOT_APPLICABLE'
                    ? '不适用'
                    : percent(metrics.refund_rate_bps)
                }
              />
              <Metric label="90 天安全事件" value={metrics.security_incidents_90d} />
            </div>
          )}
          <h3>未达标原因</h3>
          {snapshot.reasons.length ? (
            <ul>
              {snapshot.reasons.map((reason) => (
                <li key={reason.code}>
                  {REASON_LABELS[reason.code]}
                  {reason.actual == null
                    ? ''
                    : `（当前 ${reason.actual}${reason.threshold == null ? '' : ` / 目标 ${reason.threshold}`}）`}
                </li>
              ))}
            </ul>
          ) : (
            <p>当前快照已满足自动优质规则。</p>
          )}
          <label className="field">
            申诉说明
            <textarea
              rows={4}
              maxLength={10000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="说明你认为指标或排除原因异常的具体依据"
            />
          </label>
          <button
            className="button"
            disabled={!body.trim() || state === '提交中…'}
            onClick={() => void submit()}
          >
            提交申诉
          </button>
          {state && <p aria-live="polite">{state}</p>}
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function percent(value: number | null) {
  return value == null ? '数据不足' : `${(value / 100).toFixed(2)}%`;
}
