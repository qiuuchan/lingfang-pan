import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  MailIcon,
  MoonIcon,
  SaveIcon,
  SunIcon,
  MonitorIcon,
  SendIcon,
  ShieldCheckIcon,
  GitBranchIcon,
  Loader2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Section, InfoGrid } from '@/components/shared';
import { RevealSecretButton, ThemeOption } from '@/components/settings/SettingsShared';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/api';
import pkg from '../../../package.json';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// 平台基础信息：云端存储（PlatformSetting 表 platformName/logoUrl）。
// 加载用公开端点 GET /api/platform-info（扁平 {platformName, logoUrl, ...}），
// 保存用 PATCH /api/admin/settings（{settings:[{key,value}]}，key 受后端白名单约束）。
// 所有端（admin / 桌面 / 官网落地页）拉同一 platform-info，改后云端同步可见。
type PlatformInfo = {
  platformName: string;
  logoUrl: string;
};

const DEFAULT_PLATFORM_INFO: PlatformInfo = {
  platformName: 'LingFang',
  logoUrl: '',
};

// SMTP 配置：从 GET /api/admin/settings/smtp 加载（PlatformSetting 优先，.env fallback）。
// hasSmtpPass 标记后端是否已存密码（密码不返回明文，避免经 HTTP 泄漏到浏览器）。
type SmtpSettings = {
  smtpUrl: string;
  smtpFrom: string;
  smtpUser: string;
  hasSmtpPass: boolean;
  hasSmtpUrl: boolean;
};

const EMPTY_SMTP: SmtpSettings = {
  smtpUrl: '',
  smtpFrom: '',
  smtpUser: '',
  hasSmtpPass: false,
  hasSmtpUrl: false,
};

// 组C 极验配置：从 GET /api/admin/settings/geetest 加载。
// captchaId/scenes 明文（captchaId 本就公开、scenes 非密钥），captchaKey 脱敏（hasCaptchaKey 布尔）。
type GeetestSettings = {
  geetestCaptchaId: string;
  hasCaptchaKey: boolean;
  geetestScenes: string;
  hasCaptchaId: boolean;
};

const EMPTY_GEETEST: GeetestSettings = {
  geetestCaptchaId: '',
  hasCaptchaKey: false,
  geetestScenes: '',
  hasCaptchaId: false,
};

/** 极验场景元数据：label + value，渲染勾选项 + 序列化为逗号分隔串提交。
 *  与后端 settings.service KEY_VALIDATORS.geetestScenes 的 SCENES 白名单一致（admin_login/admin_forgot）。 */
const GEETEST_SCENE_OPTIONS: Array<{ value: string; label: string; desc: string }> = [
  { value: 'admin_login', label: '管理端登录', desc: '管理端登录表单强制验证码' },
  { value: 'admin_forgot', label: '管理端找回密码', desc: '管理端找回密码表单强制验证码' },
];

// 组D Gitee 更新日志源配置：从 GET /api/admin/settings/gitee 加载。
// owner/repo 明文（非密钥），accessToken 脱敏（hasAccessToken 布尔）。
type GiteeSettings = {
  giteeOwner: string;
  giteeRepo: string;
  hasAccessToken: boolean;
};

const EMPTY_GITEE: GiteeSettings = {
  giteeOwner: '',
  giteeRepo: '',
  hasAccessToken: false,
};

// 组E 搜索源：searxngUrl 明文 + tavily/brave 密钥脱敏（hasXxx 布尔）。
type SearchSettings = {
  searxngUrl: string;
  hasTavilyApiKey: boolean;
  hasBraveApiKey: boolean;
};
const EMPTY_SEARCH: SearchSettings = {
  searxngUrl: '',
  hasTavilyApiKey: false,
  hasBraveApiKey: false,
};

// framer-motion 卡片入场：stagger 错峰，使多卡依次滑入。
const containerVariant = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07 } },
};
const cardVariant = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: 'easeOut' as const } },
};

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<'basic' | 'email' | 'security' | 'release' | 'search'>('basic');
  const loadedTabs = useRef(new Set<string>());
  const { mode, setTheme } = useTheme();
  // 平台信息：从云端 GET /api/platform-info（公开扁平端点）加载 platformName/logoUrl。
  // info = 已保存快照（重置基准 + 展示态），draft = 编辑草稿（保存时才 PATCH 到云端）。
  const [info, setInfo] = useState<PlatformInfo>(DEFAULT_PLATFORM_INFO);
  const [draft, setDraft] = useState<PlatformInfo>(DEFAULT_PLATFORM_INFO);
  const [platformInfoLoading, setPlatformInfoLoading] = useState(true);
  const [platformInfoSaving, setPlatformInfoSaving] = useState(false);
  // 测试发信：调 POST /api/admin/settings/test-email，验证 SMTP 配置是否正常。
  const [testEmail, setTestEmail] = useState('');
  const [testEmailLoading, setTestEmailLoading] = useState(false);
  // SMTP 编辑表单：从 GET /api/admin/settings/smtp 加载当前生效配置（含 .env fallback）。
  // smtpPassDraft 仅在 admin 输入新密码时才有值（后端不返回明文，表单用占位提示「已配置」）。
  const [smtp, setSmtp] = useState<SmtpSettings>(EMPTY_SMTP);
  const [smtpDraft, setSmtpDraft] = useState<SmtpSettings>(EMPTY_SMTP);
  const [smtpPassDraft, setSmtpPassDraft] = useState('');
  const [smtpLoading, setSmtpLoading] = useState(true);
  const [smtpSaving, setSmtpSaving] = useState(false);

  // 组C 极验配置：从 GET /api/admin/settings/geetest 加载（captchaId/scenes 明文，captchaKey 脱敏）。
  // captchaKeyDraft 仅在 admin 输入新 key 时才有值（后端不返回明文）。
  // scenesDraft 是勾选的管理端场景集合（admin_login/admin_forgot），保存时序列化为逗号分隔串提交。
  const [geetest, setGeetest] = useState<GeetestSettings>(EMPTY_GEETEST);
  const [geetestDraft, setGeetestDraft] = useState<GeetestSettings>(EMPTY_GEETEST);
  const [geetestCaptchaKeyDraft, setGeetestCaptchaKeyDraft] = useState('');
  const [geetestScenesDraft, setGeetestScenesDraft] = useState<Set<string>>(new Set());
  const [geetestLoading, setGeetestLoading] = useState(true);
  const [geetestSaving, setGeetestSaving] = useState(false);
  const [geetestTesting, setGeetestTesting] = useState(false);

  // 组D Gitee 更新日志源：从 GET /api/admin/settings/gitee 加载（owner/repo 明文，accessToken 脱敏）。
  // accessTokenDraft 仅在 admin 输入新值时才有值（后端不返回明文，与极验 captchaKeyDraft 同款）。
  const [gitee, setGitee] = useState<GiteeSettings>(EMPTY_GITEE);
  const [giteeDraft, setGiteeDraft] = useState<GiteeSettings>(EMPTY_GITEE);
  const [giteeAccessTokenDraft, setGiteeAccessTokenDraft] = useState('');
  const [giteeLoading, setGiteeLoading] = useState(true);
  const [giteeSaving, setGiteeSaving] = useState(false);
  const [giteeTesting, setGiteeTesting] = useState(false);

  // 组E 搜索源：searxngUrl 明文 + tavily/brave 密钥脱敏。AI 联网搜索的源配置。
  // 密钥 Draft 仅在输入新值时非空（留空保持不变，与 Gitee token 同款约定）。
  const [search, setSearch] = useState<SearchSettings>(EMPTY_SEARCH);
  const [searchDraft, setSearchDraft] = useState<SearchSettings>(EMPTY_SEARCH);
  const [tavilyKeyDraft, setTavilyKeyDraft] = useState('');
  const [braveKeyDraft, setBraveKeyDraft] = useState('');
  const [searchLoading, setSearchLoading] = useState(true);
  const [searchSaving, setSearchSaving] = useState(false);

  // 每个配置域首次打开时加载；草稿 state 留在本组件，切换 Tab 不丢失也不重复请求。
  useEffect(() => {
    if (loadedTabs.current.has(activeTab)) return;
    loadedTabs.current.add(activeTab);
    let cancelled = false;
    if (activeTab === 'basic') api<PlatformInfo>('/api/platform-info', { auth: false })
      .then((data) => {
        if (cancelled) return;
        const next = {
          platformName: (data.platformName || '').trim() || DEFAULT_PLATFORM_INFO.platformName,
          logoUrl: (data.logoUrl || '').trim(),
        };
        setInfo(next);
        setDraft(next);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(`平台信息加载失败：${(e as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setPlatformInfoLoading(false);
      });
    if (activeTab === 'email') api<SmtpSettings>('/api/admin/settings/smtp')
      .then((data) => {
        if (cancelled) return;
        const next = { ...EMPTY_SMTP, ...data };
        setSmtp(next);
        setSmtpDraft(next);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(`SMTP 配置加载失败：${(e as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setSmtpLoading(false);
      });
    if (activeTab === 'security') api<GeetestSettings>('/api/admin/settings/geetest')
      .then((data) => {
        if (cancelled) return;
        const next = { ...EMPTY_GEETEST, ...data };
        setGeetest(next);
        setGeetestDraft(next);
        // 解析 scenes 逗号分隔串为 Set（勾选状态）。
        setGeetestScenesDraft(new Set(next.geetestScenes.split(',').map((s) => s.trim()).filter(Boolean)));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(`极验配置加载失败：${(e as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setGeetestLoading(false);
      });
    if (activeTab === 'release') api<GiteeSettings>('/api/admin/settings/gitee')
      .then((data) => {
        if (cancelled) return;
        const next = { ...EMPTY_GITEE, ...data };
        setGitee(next);
        setGiteeDraft(next);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(`Gitee 配置加载失败：${(e as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setGiteeLoading(false);
      });
    if (activeTab === 'search') api<SearchSettings>('/api/admin/settings/search')
      .then((data) => {
        if (cancelled) return;
        const next = { ...EMPTY_SEARCH, ...data };
        setSearch(next);
        setSearchDraft(next);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(`搜索源配置加载失败：${(e as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  // 保存 SMTP 配置：PATCH /api/admin/settings（批量 upsert）。
  // 提交策略：
  //  - smtpUrl/smtpFrom/smtpUser 始终提交（空值=清空，回退 .env fallback 或 url 内嵌）。
  //  - smtpPass 仅在 admin 输入了新值时提交（不输入=保持后端已存密码不变，避免空值覆盖丢失密码）。
  async function saveSmtpSettings() {
    setSmtpSaving(true);
    try {
      const entries: Array<{ key: string; value: string }> = [
        { key: 'smtpUrl', value: smtpDraft.smtpUrl.trim() },
        { key: 'smtpFrom', value: smtpDraft.smtpFrom.trim() },
        { key: 'smtpUser', value: smtpDraft.smtpUser.trim() },
      ];
      if (smtpPassDraft.length > 0) entries.push({ key: 'smtpPass', value: smtpPassDraft });
      await api('/api/admin/settings', { method: 'PATCH', body: { settings: entries } });
      // 保存成功后同步本地快照 + 清空密码草稿（后端已存新密码，下次加载 hasSmtpPass=true）。
      setSmtp(smtpDraft);
      setSmtpPassDraft('');
      if (smtpPassDraft.length > 0) setSmtpDraft({ ...smtpDraft, hasSmtpPass: true });
      toast.success('SMTP 配置已保存，运行时即时生效');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSmtpSaving(false);
    }
  }

  // 保存平台信息到云端：PATCH /api/admin/settings（批量 upsert platformName/logoUrl）。
  // 保存成功后同步本地快照，所有端拉 platform-info 即见新值（后端已失效公开信息缓存，下次请求回源最新值）。
  async function savePlatformInfo() {
    const next: PlatformInfo = {
      platformName: draft.platformName.trim() || DEFAULT_PLATFORM_INFO.platformName,
      logoUrl: draft.logoUrl.trim(),
    };
    setPlatformInfoSaving(true);
    try {
      await api('/api/admin/settings', {
        method: 'PATCH',
        body: {
          settings: [
            { key: 'platformName', value: next.platformName },
            { key: 'logoUrl', value: next.logoUrl },
          ],
        },
      });
      setInfo(next);
      setDraft(next);
      toast.success('平台信息已保存，全端生效');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPlatformInfoSaving(false);
    }
  }

  // 调用后端 /api/admin/settings/test-email 发送测试邮件，验证 SMTP 配置。
  // 后端返回 {ok, configured, message}：ok=true 提示成功，false 提示失败原因（如 SMTP 未配 / 认证失败）。
  async function sendTestEmail() {
    if (!testEmail.trim()) return toast.error('请输入收件邮箱');
    setTestEmailLoading(true);
    try {
      const result = await api<{ ok: boolean; configured: boolean; message: string }>(
        '/api/admin/settings/test-email',
        { method: 'POST', body: { to: testEmail.trim() } },
      );
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestEmailLoading(false);
    }
  }

  // 组C 极验：保存极验配置（captchaId/captchaKey/scenes 批量 upsert）。
  // 提交策略：
  //  - captchaId 始终提交（空值=清空，开发态跳过）。
  //  - captchaKey 仅在 admin 输入新值时提交（不输入=保持后端已存 key 不变，避免空值覆盖丢失）。
  //  - scenes 始终提交（按勾选场景序列化为逗号分隔串，空串=全部场景关闭）。
  async function saveGeetestSettings() {
    setGeetestSaving(true);
    try {
      const scenes = GEETEST_SCENE_OPTIONS
        .filter((opt) => geetestScenesDraft.has(opt.value))
        .map((opt) => opt.value)
        .join(',');
      const entries: Array<{ key: string; value: string }> = [
        { key: 'geetestCaptchaId', value: geetestDraft.geetestCaptchaId.trim() },
        { key: 'geetestScenes', value: scenes },
      ];
      if (geetestCaptchaKeyDraft.length > 0) entries.push({ key: 'geetestCaptchaKey', value: geetestCaptchaKeyDraft });
      await api('/api/admin/settings', { method: 'PATCH', body: { settings: entries } });
      // 保存成功后同步本地快照 + 清空 key 草稿（后端已存新 key，下次加载 hasCaptchaKey=true）。
      setGeetest({ ...geetestDraft, geetestScenes: scenes, hasCaptchaKey: geetestCaptchaKeyDraft.length > 0 ? true : geetestDraft.hasCaptchaKey });
      setGeetestDraft((prev) => ({ ...prev, geetestScenes: scenes, hasCaptchaKey: geetestCaptchaKeyDraft.length > 0 ? true : prev.hasCaptchaKey }));
      setGeetestCaptchaKeyDraft('');
      toast.success('极验配置已保存，运行时即时生效');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGeetestSaving(false);
    }
  }

  // 组C 极验：测试配置连通性（POST /api/admin/settings/test-captcha，无 body）。
  // 后端读已保存的 captchaId/captchaKey 探测极验接口连通性，返回 {ok, configured, message}。
  // 注意：测试的是「已保存」的配置，admin 改了未保存时需先保存再测试。
  async function testGeetest() {
    if (geetestDraft.geetestCaptchaId.trim() !== geetest.geetestCaptchaId || geetestCaptchaKeyDraft.length > 0) {
      return toast.error('配置已修改，请先保存再测试');
    }
    setGeetestTesting(true);
    try {
      const result = await api<{ ok: boolean; configured: boolean; message: string }>(
        '/api/admin/settings/test-captcha',
        { method: 'POST' },
      );
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGeetestTesting(false);
    }
  }

  // 组D Gitee：保存配置（owner/repo/accessToken 批量 upsert）。
  // 提交策略：owner/repo 始终提交（空值=用默认，后端读侧兜底）；accessToken 仅在 admin 输入新值时提交
  // （不输入=保持后端已存 token 不变，避免空值覆盖丢失，与极验 captchaKey 同款）。
  async function saveGiteeSettings() {
    setGiteeSaving(true);
    try {
      const entries: Array<{ key: string; value: string }> = [
        { key: 'giteeOwner', value: giteeDraft.giteeOwner.trim() },
        { key: 'giteeRepo', value: giteeDraft.giteeRepo.trim() },
      ];
      if (giteeAccessTokenDraft.length > 0) entries.push({ key: 'giteeAccessToken', value: giteeAccessTokenDraft });
      await api('/api/admin/settings', { method: 'PATCH', body: { settings: entries } });
      // 保存成功后同步本地快照 + 清空 token 草稿（后端已存新 token，下次加载 hasAccessToken=true）。
      setGitee({
        ...giteeDraft,
        hasAccessToken: giteeAccessTokenDraft.length > 0 ? true : giteeDraft.hasAccessToken,
      });
      setGiteeDraft((prev) => ({
        ...prev,
        hasAccessToken: giteeAccessTokenDraft.length > 0 ? true : prev.hasAccessToken,
      }));
      setGiteeAccessTokenDraft('');
      toast.success('Gitee 配置已保存，更新日志缓存即时刷新');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGiteeSaving(false);
    }
  }

  // 组E 搜索源：保存（PATCH /api/admin/settings 批量 upsert）。
  // 密钥 Draft 仅在输入新值时提交（留空保持不变，与 Gitee token 同款约定）。
  async function saveSearchSettings() {
    setSearchSaving(true);
    try {
      const entries: Array<{ key: string; value: string }> = [
        { key: 'searxngUrl', value: searchDraft.searxngUrl.trim() },
      ];
      if (tavilyKeyDraft.length > 0) entries.push({ key: 'tavilyApiKey', value: tavilyKeyDraft });
      if (braveKeyDraft.length > 0) entries.push({ key: 'braveApiKey', value: braveKeyDraft });
      await api('/api/admin/settings', { method: 'PATCH', body: { settings: entries } });
      // 同步本地快照 + 清空密钥草稿（后端已存新值，下次加载 hasXxx=true）。
      const updated: SearchSettings = {
        searxngUrl: searchDraft.searxngUrl.trim(),
        hasTavilyApiKey: tavilyKeyDraft.length > 0 ? true : searchDraft.hasTavilyApiKey,
        hasBraveApiKey: braveKeyDraft.length > 0 ? true : searchDraft.hasBraveApiKey,
      };
      setSearch(updated);
      setSearchDraft(updated);
      setTavilyKeyDraft('');
      setBraveKeyDraft('');
      toast.success('搜索源配置已保存');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSearchSaving(false);
    }
  }

  // 组D Gitee：测试连通性（POST /api/admin/settings/test-gitee，无 body）。
  // 后端读已保存的 owner/repo/token 探测 Gitee releases 端点，返回 {ok, configured, message}。
  // 注意：测试「已保存」的配置，admin 改了未保存时需先保存再测试（与极验 testGeetest 同款）。
  async function testGitee() {
    if (
      giteeDraft.giteeOwner.trim() !== gitee.giteeOwner ||
      giteeDraft.giteeRepo.trim() !== gitee.giteeRepo ||
      giteeAccessTokenDraft.length > 0
    ) {
      return toast.error('配置已修改，请先保存再测试');
    }
    setGiteeTesting(true);
    try {
      const result = await api<{ ok: boolean; configured: boolean; message: string }>(
        '/api/admin/settings/test-gitee',
        { method: 'POST' },
      );
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGiteeTesting(false);
    }
  }

  return (
    <div className="space-y-6">
    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
      <TabsList className="max-w-full overflow-x-auto">
        <TabsTrigger value="basic">基础</TabsTrigger><TabsTrigger value="email">邮件</TabsTrigger><TabsTrigger value="security">安全</TabsTrigger><TabsTrigger value="release">发布源</TabsTrigger><TabsTrigger value="search">搜索</TabsTrigger>
      </TabsList>
    </Tabs>
    <motion.div
      variants={containerVariant}
      initial="hidden"
      animate="show"
      className="space-y-8"
    >
      {/* 平台信息 */}
      <motion.div variants={cardVariant} className={activeTab === 'basic' ? undefined : 'hidden'}>
        <Section
          title="平台信息"
          description="平台名称与 Logo，云端存储并对全端（管理端 / 桌面客户端 / 官网）同步生效。"
        >
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[auto_1fr]">
              <div className="flex items-center gap-3">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-primary text-primary-foreground">
                  {/* logoUrl 有值显示图片，无值 fallback 首字母 logo（平台名首字符）。 */}
                  {draft.logoUrl ? (
                    <img
                      src={draft.logoUrl}
                      alt="平台 Logo"
                      className="size-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="text-2xl font-bold">
                      {(draft.platformName || 'L').slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Logo 链接为空时，
                  <br />用平台名首字母作默认头像。
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="platform-name">平台名称</Label>
                  <Input
                    id="platform-name"
                    value={draft.platformName}
                    onChange={(e) => setDraft({ ...draft, platformName: e.target.value })}
                    placeholder="LingFang"
                    disabled={platformInfoLoading}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="logo-url">Logo 链接</Label>
                  <Input
                    id="logo-url"
                    value={draft.logoUrl}
                    onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })}
                    placeholder="https://example.com/logo.png"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={platformInfoLoading}
                  />
                  <p className="text-xs text-muted-foreground">
                    http/https 公开图片链接；留空则用平台名首字母占位（适用于头像与侧栏角标）。
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t pt-4">
              <Button
                variant="ghost"
                onClick={() => setDraft(info)}
                disabled={platformInfoLoading || platformInfoSaving}
              >
                重置
              </Button>
              <Button onClick={savePlatformInfo} disabled={platformInfoLoading || platformInfoSaving}>
                <SaveIcon className="mr-1 size-4" />
                {platformInfoSaving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        </Section>
      </motion.div>

      {/* 外观主题 */}
      <motion.div variants={cardVariant} className={activeTab === 'basic' ? undefined : 'hidden'}>
        <Section
          title="外观主题"
          description="切换亮色 / 暗色 / 跟随系统，偏好保存在本机并随账号生效。"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <ThemeOption
              active={mode === 'light'}
              onClick={() => setTheme('light')}
              icon={SunIcon}
              label="亮色"
              desc="浅色背景，日间舒适"
            />
            <ThemeOption
              active={mode === 'dark'}
              onClick={() => setTheme('dark')}
              icon={MoonIcon}
              label="暗色"
              desc="深色背景，护眼低耗"
            />
            <ThemeOption
              active={mode === 'system'}
              onClick={() => setTheme('system')}
              icon={MonitorIcon}
              label="跟随系统"
              desc="自动匹配操作系统"
            />
          </div>
        </Section>
      </motion.div>

      {/* SMTP 配置（可编辑，保存后运行时即时生效）+ 测试发信 */}
      <motion.div variants={cardVariant} className={activeTab === 'email' ? undefined : 'hidden'}>
        <Section
          title="邮件服务（SMTP）"
          description="邀请码、审批通知、找回密码与邮箱验证邮件经由平台 SMTP 发送。配置保存后运行时即时生效（无需重启）。"
        >
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <MailIcon className="size-3.5" />
            <span>
              配置优先级：此处后台配置 &gt; 服务端 .env（SMTP_URL / SMTP_FROM 仅作 fallback）。
              独立用户名 / 密码未填时，凭据可内嵌在 SMTP 连接 URL（如 smtps://user:pass@host:465）。
            </span>
          </div>

          {/* 编辑表单：smtpUrl / smtpFrom / smtpUser / smtpPass。
              smtpPass 输入框：后端不返回明文，已配置时显示占位「已配置，留空保持不变」。
              加载中（smtpLoading）用 disabled 占位，避免空表单一闪而过。 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="smtp-url">SMTP 服务器地址</Label>
              <Input
                id="smtp-url"
                value={smtpDraft.smtpUrl}
                onChange={(e) => setSmtpDraft({ ...smtpDraft, smtpUrl: e.target.value })}
                placeholder="smtpdm.aliyun.com:465"
                disabled={smtpLoading}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                填服务器地址[:端口]，自动识别 SSL。常见服务商：
                阿里云 <code className="rounded bg-muted px-1">smtpdm.aliyun.com:465</code>、
                QQ <code className="rounded bg-muted px-1">smtp.qq.com:465</code>、
                163 <code className="rounded bg-muted px-1">smtp.163.com:465</code>、
                Gmail <code className="rounded bg-muted px-1">smtp.gmail.com:587</code>。
                也可填完整格式 <code className="rounded bg-muted px-1">smtps://host:port</code>。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-from">发件人地址</Label>
              <Input
                id="smtp-from"
                value={smtpDraft.smtpFrom}
                onChange={(e) => setSmtpDraft({ ...smtpDraft, smtpFrom: e.target.value })}
                placeholder="LingFang 平台 <no-reply@example.com>"
                disabled={smtpLoading}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">未填用平台默认（含品牌名）。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-user">认证用户名</Label>
              <Input
                id="smtp-user"
                value={smtpDraft.smtpUser}
                onChange={(e) => setSmtpDraft({ ...smtpDraft, smtpUser: e.target.value })}
                placeholder="（可选，URL 内嵌凭据时可不填）"
                disabled={smtpLoading}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-pass">认证密码</Label>
              <Input
                id="smtp-pass"
                type="password"
                value={smtpPassDraft}
                onChange={(e) => setSmtpPassDraft(e.target.value)}
                placeholder={smtpDraft.hasSmtpPass ? '已配置，留空保持不变' : '（未配置）'}
                disabled={smtpLoading}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {smtpDraft.hasSmtpPass
                  ? '当前已配置密码，留空提交则保持原密码不变。'
                  : '独立配置密码（与 URL 内嵌凭据二选一）。'}
              </p>
              {/* 查看已存密码明文（需二次密码确认 + 审计）；未配置时不允许查看。 */}
              <RevealSecretButton
                secretKey="smtpPass"
                label="SMTP 认证密码"
                hasConfigured={smtpDraft.hasSmtpPass}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button
              variant="ghost"
              onClick={() => {
                setSmtpDraft(smtp);
                setSmtpPassDraft('');
              }}
              disabled={smtpLoading || smtpSaving}
            >
              重置
            </Button>
            <Button onClick={saveSmtpSettings} disabled={smtpLoading || smtpSaving}>
              <SaveIcon className="mr-1 size-4" />
              {smtpSaving ? '保存中…' : '保存 SMTP 配置'}
            </Button>
          </div>

          {/* 测试发信：输入收件邮箱 → 调 /api/admin/settings/test-email → 返回成功 / 失败 + 错误信息 */}
          <div className="mt-4 rounded-xl border bg-muted/20 p-4">
            <div className="mb-2 text-sm font-medium">测试发信</div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="test-email-input">收件邮箱</Label>
                <Input
                  id="test-email-input"
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="admin@example.com"
                  onKeyDown={(e) => e.key === 'Enter' && sendTestEmail()}
                />
              </div>
              <Button onClick={sendTestEmail} disabled={testEmailLoading} className="sm:mb-[1px]">
                <SendIcon className="mr-1 size-4" />
                {testEmailLoading ? '发送中…' : '发送测试邮件'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              点击后后端会通过当前 SMTP 配置向该邮箱发一封测试邮件。若失败，错误信息会显示在右上角通知（便于排查 SMTP 连接 / 认证问题）。
            </p>
          </div>

          <div className="mt-3">
            <Badge variant="outline" className="text-muted-foreground">
              {smtpLoading
                ? '配置加载中…'
                : smtp.hasSmtpUrl
                  ? 'SMTP 已配置 · 后台配置优先于 .env'
                  : 'SMTP 未配置 · 邮件降级为 console.log'}
            </Badge>
          </div>
        </Section>
      </motion.div>

      {/* 组C 极验验证码服务（captchaId/captchaKey/scenes 场景开关 + 测试连通性） */}
      <motion.div variants={cardVariant} className={activeTab === 'security' ? undefined : 'hidden'}>
        <Section
          title="验证码服务（极验）"
          description="管理端登录 / 管理端找回密码表单的图形验证码。配置 captchaId（公开）与 captchaKey（私钥，脱敏不返回明文），并按管理端场景勾选启用。保存后运行时即时生效（无需重启）。"
        >
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheckIcon className="size-3.5" />
            <span>
              captchaId 公开（前端 platform-info 据此初始化极验组件），captchaKey 仅后端校验用（绝不公开）。
              未配置或未勾选任何场景时，对应表单不强制验证码（开发态可空跑）。
            </span>
          </div>

          {/* 编辑表单：captchaId / captchaKey。
              captchaKey 输入框：后端不返回明文，已配置时显示占位「已配置，留空保持不变」。
              加载中（geetestLoading）用 disabled 占位，避免空表单一闪而过。 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="geetest-captcha-id">极验 captchaId</Label>
              <Input
                id="geetest-captcha-id"
                value={geetestDraft.geetestCaptchaId}
                onChange={(e) => setGeetestDraft({ ...geetestDraft, geetestCaptchaId: e.target.value })}
                placeholder="（32 位 hex，极验控制台获取）"
                disabled={geetestLoading}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                极验控制台「应用管理」里的 captchaId，前端据此加载验证码组件。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="geetest-captcha-key">极验 captchaKey（私钥）</Label>
              <Input
                id="geetest-captcha-key"
                type="password"
                value={geetestCaptchaKeyDraft}
                onChange={(e) => setGeetestCaptchaKeyDraft(e.target.value)}
                placeholder={geetestDraft.hasCaptchaKey ? '已配置，留空保持不变' : '（未配置）'}
                disabled={geetestLoading}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {geetestDraft.hasCaptchaKey
                  ? '当前已配置私钥，留空提交则保持原 key 不变。'
                  : '极验控制台「应用管理」里的 captchaKey，仅后端二次校验用。'}
              </p>
              {/* 查看已存私钥明文（需二次密码确认 + 审计）；未配置时不允许查看。 */}
              <RevealSecretButton
                secretKey="geetestCaptchaKey"
                label="极验 captchaKey 私钥"
                hasConfigured={geetestDraft.hasCaptchaKey}
              />
            </div>
          </div>

          {/* 场景开关：admin_login/admin_forgot 勾选，决定哪些管理端场景强制验证码。 */}
          <div className="mt-4 space-y-2">
            <Label>启用场景</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {GEETEST_SCENE_OPTIONS.map((opt) => {
                const checked = geetestScenesDraft.has(opt.value);
                return (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 text-sm transition-colors ${
                      checked ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setGeetestScenesDraft((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(opt.value);
                          else next.delete(opt.value);
                          return next;
                        });
                      }}
                    />
                    <div className="min-w-0">
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-xs text-muted-foreground">{opt.desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              勾选的场景在对应表单强制验证码；未勾选则跳过（即便配了 id/key 也不校验）。
            </p>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button
              variant="ghost"
              onClick={() => {
                setGeetestDraft(geetest);
                setGeetestCaptchaKeyDraft('');
                setGeetestScenesDraft(new Set(geetest.geetestScenes.split(',').map((s) => s.trim()).filter(Boolean)));
              }}
              disabled={geetestLoading || geetestSaving}
            >
              重置
            </Button>
            <Button onClick={saveGeetestSettings} disabled={geetestLoading || geetestSaving}>
              <SaveIcon className="mr-1 size-4" />
              {geetestSaving ? '保存中…' : '保存极验配置'}
            </Button>
          </div>

          {/* 测试连通性：调 /api/admin/settings/test-captcha → 返回成功 / 失败 + 错误信息 */}
          <div className="mt-4 rounded-xl border bg-muted/20 p-4">
            <div className="mb-2 text-sm font-medium">测试连通性</div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <p className="flex-1 text-xs text-muted-foreground">
                点击后后端会读已保存的 captchaId / captchaKey 向极验接口发探测请求，校验连通性与 key 有效性。
                若失败，错误信息会显示在右上角通知（便于排查 captchaId / key 是否正确）。
              </p>
              <Button onClick={testGeetest} disabled={geetestTesting || geetestLoading || geetestSaving} className="sm:mb-[1px]">
                <ShieldCheckIcon className="mr-1 size-4" />
                {geetestTesting ? '测试中…' : '测试极验'}
              </Button>
            </div>
          </div>

          <div className="mt-3">
            <Badge variant="outline" className="text-muted-foreground">
              {geetestLoading
                ? '配置加载中…'
                : geetest.hasCaptchaId
                  ? `极验已配置 · 启用场景：${geetest.geetestScenes || '无'}`
                  : '极验未配置 · 验证码跳过'}
            </Badge>
          </div>
        </Section>
      </motion.div>

      {/* 组D Gitee 更新日志源（owner/repo 明文 + accessToken 脱敏 + 测试连通性） */}
      <motion.div variants={cardVariant} className={activeTab === 'release' ? undefined : 'hidden'}>
        <Section
          title="更新日志源（Gitee）"
          description="官网更新日志页从 Gitee 仓库 release 拉取。配置 owner / repo 与私人令牌（私有仓库必需，脱敏不返回明文），保存后更新日志缓存即时刷新（无需重启）。"
        >
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <GitBranchIcon className="size-3.5" />
            <span>
              令牌在 Gitee「设置 → 私人令牌」生成，须勾选 project 权限。owner / repo 留空则用默认（yijianruyuan / lingfang）。
              更新日志源来自 Gitee release notes，下载页版本号来自本地已签名产物，两者可能不一致（属正常）。
            </span>
          </div>

          {/* 编辑表单：owner / repo 明文，accessToken password 脱敏（已配置显示占位「已配置，留空保持不变」）。 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="gitee-owner">Gitee owner（用户/组织）</Label>
              <Input
                id="gitee-owner"
                value={giteeDraft.giteeOwner}
                onChange={(e) => setGiteeDraft({ ...giteeDraft, giteeOwner: e.target.value })}
                placeholder="yijianruyuan"
                disabled={giteeLoading}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">留空用默认 yijianruyuan。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="gitee-repo">Gitee 仓库名</Label>
              <Input
                id="gitee-repo"
                value={giteeDraft.giteeRepo}
                onChange={(e) => setGiteeDraft({ ...giteeDraft, giteeRepo: e.target.value })}
                placeholder="lingfang"
                disabled={giteeLoading}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">留空用默认 lingfang。</p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="gitee-token">Gitee 私人令牌（私有仓库必需）</Label>
              <Input
                id="gitee-token"
                type="password"
                value={giteeAccessTokenDraft}
                onChange={(e) => setGiteeAccessTokenDraft(e.target.value)}
                placeholder={giteeDraft.hasAccessToken ? '已配置，留空保持不变' : '（未配置，更新日志将显示「未配置」）'}
                disabled={giteeLoading}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {giteeDraft.hasAccessToken
                  ? '当前已配置令牌，留空提交则保持原令牌不变。'
                  : 'Gitee「设置 → 私人令牌」生成，勾选 project 权限。仅后端拉取用，绝不公开。'}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button
              variant="ghost"
              onClick={() => {
                setGiteeDraft(gitee);
                setGiteeAccessTokenDraft('');
              }}
              disabled={giteeLoading || giteeSaving}
            >
              重置
            </Button>
            <Button onClick={saveGiteeSettings} disabled={giteeLoading || giteeSaving}>
              <SaveIcon className="mr-1 size-4" />
              {giteeSaving ? '保存中…' : '保存 Gitee 配置'}
            </Button>
          </div>

          {/* 测试连通性：调 /api/admin/settings/test-gitee → 返回成功 / 失败 + 错误信息 */}
          <div className="mt-4 rounded-xl border bg-muted/20 p-4">
            <div className="mb-2 text-sm font-medium">测试连通性</div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <p className="flex-1 text-xs text-muted-foreground">
                点击后后端会读已保存的 owner / repo / token 向 Gitee releases 端点发探测请求，校验连通性与令牌有效性。
                若失败，错误信息会显示在右上角通知（便于排查 token 失效 / 缺权限 / owner-repo 错误）。
              </p>
              <Button onClick={testGitee} disabled={giteeTesting || giteeLoading || giteeSaving} className="sm:mb-[1px]">
                <GitBranchIcon className="mr-1 size-4" />
                {giteeTesting ? '测试中…' : '测试 Gitee'}
              </Button>
            </div>
          </div>

          <div className="mt-3">
            <Badge variant="outline" className="text-muted-foreground">
              {giteeLoading
                ? '配置加载中…'
                : gitee.hasAccessToken
                  ? `Gitee 已配置 · ${gitee.giteeOwner || 'yijianruyuan'}/${gitee.giteeRepo || 'lingfang'}`
                  : 'Gitee 未配置 · 更新日志降级显示「未配置」'}
            </Badge>
          </div>
        </Section>
      </motion.div>

      {/* 组E 搜索源（AI 联网搜索的源配置：自建 SearXNG + Tavily/Brave 密钥）。
          未配置任何密钥时仅靠公共 SearXNG + Bing 兜底，大陆网络下公共源常不可达、
          Bing 对数据中心 IP 易反爬，导致搜索无结果。配置 Tavily 或 Brave 密钥可显著改善。 */}
      <motion.div variants={cardVariant} className={activeTab === 'search' ? undefined : 'hidden'}>
        <Section
          title="搜索源（AI 联网搜索）"
          description="AI 的 WebSearch 工具用的搜索源。免密钥时有公共 SearXNG + Bing 兜底，但大陆网络下公共源常不可达、Bing 对服务器 IP 易反爬（中文新闻类查询可能返回空）。配置 Tavily 或 Brave 密钥可显著提升搜索成功率与质量。密钥脱敏不返回明文。"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="searxng-url">自建 SearXNG 地址（可选，优先级最高）</Label>
              <Input
                id="searxng-url"
                value={searchDraft.searxngUrl}
                onChange={(e) => setSearchDraft({ ...searchDraft, searxngUrl: e.target.value })}
                placeholder="https://searxng.your-domain.com"
                disabled={searchLoading}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">自部署的 SearXNG 实例地址（留空用公共源）。优先级高于 Tavily/Brave。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tavily-key">Tavily API Key（推荐，专为 AI 优化）</Label>
              <Input
                id="tavily-key"
                type="password"
                value={tavilyKeyDraft}
                onChange={(e) => setTavilyKeyDraft(e.target.value)}
                placeholder={searchDraft.hasTavilyApiKey ? '已配置，留空保持不变' : 'tvly-xxxxxx（tavily.com 注册获取）'}
                disabled={searchLoading}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {searchDraft.hasTavilyApiKey ? '当前已配置，留空提交保持不变。' : 'tavily.com 注册，免费额度 1000 次/月。专为 AI 搜索优化。'}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="brave-key">Brave Search API Key（可选）</Label>
              <Input
                id="brave-key"
                type="password"
                value={braveKeyDraft}
                onChange={(e) => setBraveKeyDraft(e.target.value)}
                placeholder={searchDraft.hasBraveApiKey ? '已配置，留空保持不变' : 'BSAxxxxxx（brave.com/search/api 获取）'}
                disabled={searchLoading}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {searchDraft.hasBraveApiKey ? '当前已配置，留空提交保持不变。' : 'brave.com/search/api 注册，免费额度 2000 次/月。'}
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <Badge variant={searchLoading ? 'secondary' : (searchDraft.hasTavilyApiKey || searchDraft.hasBraveApiKey ? 'default' : 'secondary')}>
              {searchLoading
                ? '加载中…'
                : (searchDraft.hasTavilyApiKey || searchDraft.hasBraveApiKey)
                  ? `已配置 ${[searchDraft.hasTavilyApiKey && 'Tavily', searchDraft.hasBraveApiKey && 'Brave'].filter(Boolean).join(' + ')}`
                  : '未配置密钥 · 仅靠公共源兜底（大陆易无结果）'}
            </Badge>
            <Button onClick={saveSearchSettings} disabled={searchLoading || searchSaving}>
              {searchSaving && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              保存
            </Button>
          </div>
        </Section>
      </motion.div>

      {/* 版本信息 */}
      <motion.div variants={cardVariant} className={activeTab === 'basic' ? undefined : 'hidden'}>
        <Section
          title="版本信息"
          description="当前管理端构建版本与技术栈。"
        >
          <InfoGrid
            items={[
              ['版本号', <span key="v" className="font-mono text-xs">v{pkg.version || '0.0.0'}</span>],
              ['技术栈', 'React + TypeScript + shadcn/ui'],
              ['运行时', 'Vite + framer-motion'],
            ]}
          />
        </Section>
      </motion.div>
    </motion.div>
    </div>
  );
}
