import React, { useEffect, useRef, useState } from 'react';
import type { PublicPluginDetail, WebCloudTrialProjection } from '@lingfang/contract';
import { WebApiError } from './api';
import { cancelCloudTrial, defaultTrialInput, getCloudTrial, isCloudTrialTerminal, parseTrialInput, startCloudTrial } from './cloud-trial';

const STATUS_LABEL: Record<WebCloudTrialProjection['status'], string> = {
  AUTHORIZED: '等待云端执行',
  RUNNING: '正在执行',
  SUCCEEDED: '试跑成功',
  FAILED: '试跑失败',
  CANCELED: '已取消',
  TIMED_OUT: '执行超时',
};

export function CloudTrialPanel({ detail }: { detail: PublicPluginDetail }) {
  const [actionId, setActionId] = useState(detail.preview_actions[0]?.action_id ?? '');
  const action = detail.preview_actions.find((candidate) => candidate.action_id === actionId) ?? null;
  const [inputSource, setInputSource] = useState(() => JSON.stringify(action ? defaultTrialInput(action.input_schema) : {}, null, 2));
  const [trial, setTrial] = useState<WebCloudTrialProjection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const requestKey = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!trial || isCloudTrialTerminal(trial)) return;
    let disposed = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getCloudTrial(trial.invocation_id);
        if (!disposed) {
          setTrial(next);
          setError('');
        }
      } catch (cause) {
        if (!disposed) setError(errorMessage(cause));
      }
    }, 1_200);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [trial, pollGeneration]);

  function chooseAction(nextId: string) {
    const next = detail.preview_actions.find((candidate) => candidate.action_id === nextId);
    setActionId(nextId);
    setInputSource(JSON.stringify(next ? defaultTrialInput(next.input_schema) : {}, null, 2));
    setTrial(null);
    setError('');
    requestKey.current = crypto.randomUUID();
  }

  async function start() {
    if (!action) return;
    setBusy(true);
    setError('');
    try {
      const input = parseTrialInput(inputSource);
      const accepted = await startCloudTrial(detail, action, input, requestKey.current);
      setTrial(accepted);
      requestKey.current = crypto.randomUUID();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!trial || isCloudTrialTerminal(trial)) return;
    setBusy(true);
    setError('');
    try {
      setTrial(await cancelCloudTrial(trial.invocation_id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!action) {
    return <section className="trial-panel"><h2>Cloud 安全试用</h2><div className="notice">当前发行版没有可公开试跑的只读或幂等 Action，请返回详情刷新版本信息。</div></section>;
  }

  const active = Boolean(trial && !isCloudTrialTerminal(trial));
  return <section className="trial-panel" data-mode="CLOUD_TRIAL" aria-labelledby="cloud-trial-title">
    <div className="trial-heading">
      <div><p className="eyebrow">PREVIEW · 隔离执行</p><h2 id="cloud-trial-title">Cloud 安全试用</h2></div>
      {trial && <span className={`status status-${trial.status.toLowerCase()}`} aria-live="polite">{STATUS_LABEL[trial.status]}</span>}
    </div>
    <p>结果来自真实 PREVIEW invocation。试跑不会写入团队共享数据，也不会建立正式运行记录。</p>
    <label className="field">Action
      <select value={actionId} onChange={(event) => chooseAction(event.target.value)} disabled={active || busy}>
        {detail.preview_actions.map((candidate) => <option key={candidate.action_id} value={candidate.action_id}>{candidate.name} · {candidate.action_id}</option>)}
      </select>
    </label>
    {action.description && <p className="action-description">{action.description}</p>}
    <label className="field">JSON 输入
      <textarea rows={12} value={inputSource} onChange={(event) => setInputSource(event.target.value)} spellCheck={false} disabled={active || busy} />
    </label>
    <div className="trial-actions">
      <button className="button" type="button" onClick={start} disabled={active || busy}>{busy && !trial ? '正在提交…' : '开始真实试跑'}</button>
      {active && <button className="button button-secondary" type="button" onClick={cancel} disabled={busy}>取消试跑</button>}
      {active && error && <button className="button button-secondary" type="button" onClick={() => { setError(''); setPollGeneration((value) => value + 1); }}>重新查询</button>}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {trial && <TrialResult trial={trial} />}
  </section>;
}

function TrialResult({ trial }: { trial: WebCloudTrialProjection }) {
  return <div className="trial-result">
    <dl className="trial-meta">
      <div><dt>Invocation</dt><dd><code>{trial.invocation_id}</code></dd></div>
      <div><dt>今日剩余</dt><dd>{trial.quota_remaining} / {trial.daily_limit}</dd></div>
      <div><dt>并发占用</dt><dd>{trial.concurrent_active} / {trial.concurrency_limit}</dd></div>
      <div><dt>过期时间</dt><dd>{formatTime(trial.expires_at)}</dd></div>
    </dl>
    {trial.output && <div><h3>结构化输出</h3><pre className="json-output"><code>{JSON.stringify(trial.output, null, 2)}</code></pre></div>}
    {trial.error && <div className="trial-error" role="alert"><strong>{trial.error.code}</strong><p>{trial.error.message}</p></div>}
    {!trial.output && !trial.error && !isCloudTrialTerminal(trial) && <p className="running-note">页面正在轮询统一 invocation 状态，终态前不会生成占位结果。</p>}
  </div>;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof WebApiError) {
    if (cause.status === 401) return '请先登录并选择团队后再试用 Cloud Action。';
    if (cause.status === 429) return cause.message;
    return `${cause.message}（${cause.code}）`;
  }
  return cause instanceof Error ? cause.message : 'Cloud Trial 请求失败，请稍后重试';
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}
