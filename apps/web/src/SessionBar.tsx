import React, { FormEvent, useEffect, useState } from 'react';
import {
  loadWebSession,
  loadWebTeams,
  loginWeb,
  logoutWeb,
  prepareWebSession,
  switchWebTeam,
} from './session';

type Team = { id: string; name: string };
type Session = { user?: { email?: string; displayName?: string }; team?: Team | null };

export function SessionBar() {
  const [session, setSession] = useState<Session | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    prepareWebSession()
      .then(() => loadWebSession())
      .then(async (value) => {
        setSession(value as Session);
        const teamResult = (await loadWebTeams()) as { teams?: Team[] };
        setTeams(teamResult.teams ?? []);
      })
      .catch(() => setSession(null))
      .finally(() => setReady(true));
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const value = await loginWeb(
        String(form.get('email') || ''),
        String(form.get('password') || '')
      );
      setSession(value as Session);
      const teamResult = (await loadWebTeams()) as { teams?: Team[] };
      setTeams(teamResult.teams ?? []);
      event.currentTarget.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败');
    }
  }

  async function selectTeam(teamId: string) {
    try {
      setSession((await switchWebTeam(teamId)) as Session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '团队切换失败');
    }
  }

  if (!ready)
    return (
      <div className="session-bar" aria-live="polite">
        正在读取登录状态…
      </div>
    );
  if (!session?.user)
    return (
      <form className="session-bar" onSubmit={login}>
        <input name="email" type="email" required placeholder="邮箱" aria-label="邮箱" />
        <input name="password" type="password" required placeholder="密码" aria-label="密码" />
        <button type="submit">登录</button>
        {error && <span className="error">{error}</span>}
      </form>
    );
  return (
    <div className="session-bar">
      <span>{session.user.displayName || session.user.email}</span>
      <select
        aria-label="当前团队"
        value={session.team?.id ?? ''}
        onChange={(event) => void selectTeam(event.target.value)}
      >
        {!session.team && <option value="">未选择团队</option>}
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() =>
          void logoutWeb().then(() => {
            setSession(null);
            setTeams([]);
          })
        }
      >
        退出
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
