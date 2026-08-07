import ReactDOM from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import App from '@/App';
import { initApiBase, initAuthToken } from '@/lib/api';
import {
  PACKAGE_ID,
  TEAM_ID,
  USER_ID,
  listing,
  managementItem,
  packageSummary,
  pluginPermissions,
  releaseSummary,
} from '../e2e/plugin-publishing-fixture';
import '@/index.css';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const sessionPayload = {
  token: 'test-token',
  userId: USER_ID,
  displayName: '测试用户',
  email: 'test@test.com',
  tenantId: TEAM_ID,
  tenantName: '测试团队',
  role: 'MEMBER',
  onboarding: 'TEAM_SPACE',
  isPlatformAdmin: false,
  permissions: pluginPermissions,
};

localStorage.setItem('lf:session', JSON.stringify(sessionPayload));
localStorage.setItem('lf:authToken', 'test-token');
localStorage.setItem('lf:backendUrl', window.location.origin);
localStorage.setItem('lf:sidebar-open', '1');

window.fetch = async (input) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.origin);
  if (url.pathname === '/api/auth/me') {
    return json({
      token: 'test-token',
      onboarding: 'TEAM_SPACE',
      user: {
        id: USER_ID,
        email: 'test@test.com',
        displayName: '测试用户',
        platformRole: 'NONE',
        status: 'ACTIVE',
      },
      team: { id: TEAM_ID, name: '测试团队', slug: 'test-team', role: 'MEMBER' },
      permissions: pluginPermissions,
      application: null,
    });
  }
  if (url.pathname === '/api/setup/status') return json({ needsSetup: false });
  if (url.pathname === '/api/platform-info') return json({ name: '灵坊', logoUrl: '' });
  if (url.pathname === '/api/plugin-registry/manage') return json({ items: [managementItem] });
  if (url.pathname === `/api/plugin-packages/${PACKAGE_ID}`) {
    return json({ package: packageSummary, releases: [releaseSummary], listing, entitled: true });
  }
  if (url.pathname.startsWith('/api/plugin-registry/')) return json({ items: [] });
  return json({});
};

const invoke = async (command: string) => {
  switch (command) {
    case 'list_plugin_installations':
    case 'list_draft_workspaces':
      return [];
    case 'inspect_lfplugin_v4':
      return {
        sha256: 'a'.repeat(64),
        sizeBytes: 4096,
        uncompressedSizeBytes: 8192,
        manifest: releaseSummary.manifest,
        files: [
          { path: '_meta.json', sizeBytes: 64 },
          { path: 'manifest.json', sizeBytes: 512 },
          { path: 'ui/index.html', sizeBytes: 1024 },
        ],
      };
    default:
      return null;
  }
};

Object.defineProperty(window, '__TAURI__', {
  configurable: true,
  value: {
    core: { invoke },
    event: { listen: async () => () => undefined },
  },
});

initApiBase(window.location.origin);
initAuthToken();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
    <App />
  </ThemeProvider>
);
