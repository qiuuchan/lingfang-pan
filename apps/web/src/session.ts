import { requestJson, setWebCsrfToken, type FetchImplementation } from './api';

const AnyObject = { parse(value: unknown) { if (!value || typeof value !== 'object') throw new Error('会话响应无效'); return value as Record<string, unknown>; } };

export async function prepareWebSession(fetchImplementation?: FetchImplementation) {
  const response = await requestJson('/api/web/session/csrf', AnyObject, {}, fetchImplementation);
  const token = response.csrfToken;
  if (typeof token !== 'string' || !token) throw new Error('CSRF token 无效');
  setWebCsrfToken(token);
  return token;
}

export function loginWeb(email: string, password: string, fetchImplementation?: FetchImplementation) {
  return requestJson('/api/web/session/login', AnyObject, { method: 'POST', body: JSON.stringify({ email, password }) }, fetchImplementation);
}

export function loadWebSession(fetchImplementation?: FetchImplementation) {
  return requestJson('/api/web/session', AnyObject, {}, fetchImplementation);
}

export function loadWebTeams(fetchImplementation?: FetchImplementation) {
  return requestJson('/api/web/session/teams', AnyObject, {}, fetchImplementation);
}

export function switchWebTeam(teamId: string, fetchImplementation?: FetchImplementation) {
  return requestJson('/api/web/session/team', AnyObject, { method: 'POST', body: JSON.stringify({ teamId }) }, fetchImplementation);
}

export function logoutWeb(fetchImplementation?: FetchImplementation) {
  return requestJson('/api/web/session/logout', AnyObject, { method: 'POST' }, fetchImplementation);
}
