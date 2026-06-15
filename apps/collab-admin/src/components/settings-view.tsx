import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  MailIcon,
  MoonIcon,
  SaveIcon,
  SunIcon,
  MonitorIcon,
  InfoIcon,
  SendIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Section, InfoGrid } from '@/components/shared';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/api';
import pkg from '../../package.json';

// 平台基础信息的 localStorage key（后端 /api/admin/settings 端点尚未落地，前端先本地持久化，
// 待后端就绪后改为 api() 读写，此处 TODO 标注迁移点）。
const PLATFORM_INFO_KEY = 'lf:admin-platform-info';

type PlatformInfo = {
  name: string;
  description: string;
  logoText: string;
};

const DEFAULT_PLATFORM_INFO: PlatformInfo = {
  name: 'LingFang 协作平台',
  description: '一体化协作与插件经济平台',
  logoText: 'LF',
};

function readPlatformInfo(): PlatformInfo {
  try {
    const raw = localStorage.getItem(PLATFORM_INFO_KEY);
    if (!raw) return DEFAULT_PLATFORM_INFO;
    const parsed = JSON.parse(raw) as Partial<PlatformInfo>;
    return { ...DEFAULT_PLATFORM_INFO, ...parsed };
  } catch {
    return DEFAULT_PLATFORM_INFO;
  }
}

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
  const { mode, setTheme } = useTheme();
  const [info, setInfo] = useState<PlatformInfo>(() => readPlatformInfo());
  // 草稿态：编辑过程中不立即持久化，保存时才写 localStorage + toast。
  const [draft, setDraft] = useState<PlatformInfo>(() => readPlatformInfo());
  // 测试发信：调 POST /api/admin/settings/test-email，验证 SMTP 配置是否正常。
  const [testEmail, setTestEmail] = useState('');
  const [testEmailLoading, setTestEmailLoading] = useState(false);

  // 平台信息从 localStorage 读取，无需后端请求；留空 useLoad 以保持视图模式一致。
  useEffect(() => { /* 占位：平台信息持久化在 localStorage，无后端请求 */ }, []);

  function savePlatformInfo() {
    const next = {
      name: draft.name.trim() || DEFAULT_PLATFORM_INFO.name,
      description: draft.description.trim() || DEFAULT_PLATFORM_INFO.description,
      logoText: draft.logoText.trim() || DEFAULT_PLATFORM_INFO.logoText,
    };
    localStorage.setItem(PLATFORM_INFO_KEY, JSON.stringify(next));
    setInfo(next);
    toast.success('平台信息已保存（仅本地）');
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

  return (
    <motion.div
      variants={containerVariant}
      initial="hidden"
      animate="show"
      className="space-y-8"
    >
      {/* 平台信息 */}
      <motion.div variants={cardVariant}>
        <Section
          title="平台信息"
          description="平台名称、简介与 Logo 文案，用于展示与对外识别。后端持久化端点待落地，当前仅保存在本机。"
        >
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[auto_1fr]">
              <div className="flex items-center gap-3">
                <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-primary text-2xl font-bold text-primary-foreground">
                  {(draft.logoText || 'LF').slice(0, 3)}
                </div>
                <div className="text-xs text-muted-foreground">
                  Logo 文案最多 3 个字符，
                  <br />用于头像与侧栏角标展示。
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>平台名称</Label>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="LingFang 协作平台"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Logo 文案</Label>
                  <Input
                    value={draft.logoText}
                    onChange={(e) => setDraft({ ...draft, logoText: e.target.value })}
                    placeholder="LF"
                    maxLength={3}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>平台简介</Label>
                  <Textarea
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="一句话描述平台定位"
                    rows={2}
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t pt-4">
              <Button variant="ghost" onClick={() => setDraft(info)}>重置</Button>
              <Button onClick={savePlatformInfo}>
                <SaveIcon className="mr-1 size-4" />
                保存
              </Button>
            </div>
          </div>
        </Section>
      </motion.div>

      {/* 外观主题 */}
      <motion.div variants={cardVariant}>
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

      {/* SMTP 配置（只读）+ 测试发信 */}
      <motion.div variants={cardVariant}>
        <Section
          title="邮件服务（SMTP）"
          description="邀请码、审批通知、找回密码与邮箱验证邮件经由平台 SMTP 发送。SMTP 在服务端 .env 配置，此处可发测试邮件验证配置是否正常。"
        >
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <MailIcon className="size-3.5" />
            <span>SMTP 主机 / 端口 / 加密等参数在服务端 .env（SMTP_URL / SMTP_FROM）配置，前端只读展示。</span>
          </div>
          <InfoGrid
            items={[
              ['SMTP 连接', '（由后端 .env SMTP_URL 提供，如 smtps://host:465）'],
              ['发件人', '（SMTP_FROM，未配用平台默认 no-reply）'],
              ['重置链接前缀', '（PASSWORD_RESET_BASE_URL）'],
              ['验证链接前缀', '（EMAIL_VERIFY_BASE_URL）'],
            ]}
          />

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
              SMTP 参数只读 · 在服务端 .env 配置
            </Badge>
          </div>
        </Section>
      </motion.div>

      {/* 版本信息 */}
      <motion.div variants={cardVariant}>
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

      {/* 后端端点迁移说明（TODO） */}
      <motion.div variants={cardVariant}>
        <div className="flex items-start gap-3 rounded-xl border border-dashed bg-muted/20 p-4 text-sm">
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-muted-foreground">
            <div className="font-medium text-foreground">后端端点迁移计划（TODO）</div>
            <p>
              平台信息与 SMTP 当前仅本地只读展示。后续需在 collab-api 新增
              <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">/api/admin/settings</code>
              端点（仅 PLATFORM_ADMIN），分别支持 GET 读取与 PATCH 写入平台元信息，前端再切换为 api() 调用。
            </p>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** 主题选项卡片：亮 / 暗 / 跟随系统三选一。 */
function ThemeOption({
  active,
  onClick,
  icon: Icon,
  label,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof SunIcon;
  label: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border p-4 text-left transition-colors ${
        active ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border hover:bg-muted/50'
      }`}
    >
      <Icon className={`size-5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </button>
  );
}
