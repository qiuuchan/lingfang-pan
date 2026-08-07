import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AsyncResource } from '@/components/ui/async-resource';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  UsersIcon,
  BoxesIcon,
  ClockIcon,
  PlugIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  ArrowRightIcon,
  SparklesIcon,
  WalletIcon,
  TrendingUpIcon,
  ShoppingCartIcon,
  PercentIcon,
  StarIcon,
  DownloadIcon,
} from 'lucide-react';
import { api, type DashboardData, type GenerationStats, type FinanceStats } from '@/lib/api';
import { useAsyncResource } from '@/lib/async-resource';
import { cn, money } from '@/lib/utils';
import { AnimatedNumber, MiniBarChart, Shimmer, StaggerContainer, StaggerItem } from '@/lib/motion';
import type { View } from '@/lib/types';
import type { GovernanceIntent } from '@/components/governance/types';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

// ADMIN-VIEW-02 修复：Dashboard 增加 onNavigate 回调 prop，
// quickActions 每项挂 onClick 调用 onNavigate 跳转到对应视图，
// 消除「cursor-pointer + hover + ArrowRightIcon 但无 onClick」的死链误导。
export function Dashboard({
  onNavigate,
}: { onNavigate?: (view: View, intent?: Omit<GovernanceIntent, 'nonce'>) => void } = {}) {
  const [generationOpen, setGenerationOpen] = useState(false);
  const [financeOpen, setFinanceOpen] = useState(false);
  // 三个区块独立加载和重试；单个接口失败不会遮蔽另外两个区块。
  const dashboard = useAsyncResource(
    (signal) => api<DashboardData>('/api/admin/dashboard', { signal }),
    []
  );
  const generationResource = useAsyncResource(
    (signal) => api<GenerationStats>('/api/admin/stats/generation', { signal }),
    [],
    { enabled: generationOpen }
  );
  const financeResource = useAsyncResource(
    (signal) => api<FinanceStats>('/api/admin/stats/finance', { signal }),
    [],
    { enabled: financeOpen }
  );
  const data = dashboard.data;
  const generation = generationResource.data;
  const finance = financeResource.data;

  const stats = [
    {
      label: '用户总数',
      value: data?.users ?? 0,
      desc: '全平台账号',
      icon: UsersIcon,
      color: 'text-blue-500',
    },
    {
      label: '团队总数',
      value: data?.teams ?? 0,
      desc: '活跃/停用团队',
      icon: BoxesIcon,
      color: 'text-emerald-500',
    },
    {
      label: '活跃插件包',
      value: data?.activePluginPackages ?? 0,
      desc: '可治理插件包',
      icon: PlugIcon,
      color: 'text-violet-500',
    },
    {
      label: '市场上架',
      value: data?.activeMarketplaceListings ?? 0,
      desc: '当前可见条目',
      icon: CheckCircleIcon,
      color: 'text-cyan-600',
    },
  ];

  const pendingTasks: Array<{
    label: string;
    count: number;
    icon: typeof UsersIcon;
    color: string;
    view?: View;
    intent?: Omit<GovernanceIntent, 'nonce'>;
  }> = [
    {
      label: '待审批申请',
      count: data?.pendingApplications ?? 0,
      icon: AlertCircleIcon,
      color: 'text-amber-500',
      view: 'governance',
      intent: { tab: 'applications', applicationStatus: 'PENDING' },
    },
    {
      label: '待审核插件发行版',
      count: data?.pendingPluginReviews ?? 0,
      icon: ClockIcon,
      color: 'text-violet-500',
      view: 'governance',
      intent: { tab: 'pending-releases' },
    },
    {
      label: '已下架市场插件',
      count: data?.delistedMarketplaceListings ?? 0,
      icon: AlertCircleIcon,
      color: 'text-destructive',
    },
  ];

  // ADMIN-VIEW-02：每项挂 onClick 跳转。
  const quickActions: Array<{
    label: string;
    icon: typeof UsersIcon;
    view: View;
    intent?: Omit<GovernanceIntent, 'nonce'>;
  }> = [
    { label: '创建用户', icon: UsersIcon, view: 'users' },
    { label: '创建团队', icon: BoxesIcon, view: 'teams' },
    {
      label: '治理中心',
      icon: CheckCircleIcon,
      view: 'governance',
      intent: { tab: 'applications', applicationStatus: 'PENDING' },
    },
  ];

  const baseLoading = dashboard.status === 'idle' || dashboard.status === 'loading';

  return (
    <div className="space-y-8">
      {/* Stats：基础指标卡片，交错入场 + 悬停弹性 + 数字滚动。 */}
      {dashboard.status === 'error' ? (
        <AsyncResource status={dashboard.status} error={dashboard.error} retry={dashboard.reload}>
          {null}
        </AsyncResource>
      ) : (
        <StaggerContainer className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" stagger={0.08}>
          {stats.map(({ label, value, desc, icon: Icon, color }) => (
            <StaggerItem
              key={label}
              whileHover={{ y: -4, transition: { type: 'spring', stiffness: 300, damping: 18 } }}
            >
              <StatCardSkeletonOrContent loading={baseLoading}>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardDescription>{label}</CardDescription>
                    <Icon className={cn('size-4', color)} />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold tabular-nums">
                      <AnimatedNumber value={value} />
                    </div>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </CardContent>
                </Card>
              </StatCardSkeletonOrContent>
            </StaggerItem>
          ))}
        </StaggerContainer>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant={generationOpen ? 'default' : 'outline'}
          onClick={() => setGenerationOpen((open) => !open)}
        >
          <SparklesIcon className="size-4" />
          生成质量
        </Button>
        <Button
          variant={financeOpen ? 'default' : 'outline'}
          onClick={() => setFinanceOpen((open) => !open)}
        >
          <WalletIcon className="size-4" />
          财务分析
        </Button>
      </div>

      {/* AI 生成质量（调研报告 Top10 / A4）：调用次数 / 成功率 / 失败数。
          后端基于 LlmCallLog（relay 每次 AI 调用记录）聚合，真实反映调用量与质量。 */}
      {generationOpen && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <SparklesIcon className="size-4 text-violet-500" />
            <h2 className="text-sm font-semibold">AI 生成质量</h2>
            <span className="text-xs text-muted-foreground">基于模型调用日志聚合</span>
          </div>
          {generationResource.status === 'error' ? (
            <AsyncResource
              status={generationResource.status}
              error={generationResource.error}
              retry={generationResource.reload}
            >
              {null}
            </AsyncResource>
          ) : (
            <StaggerContainer className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" stagger={0.08}>
              <StaggerItem
                whileHover={{ y: -4, transition: { type: 'spring', stiffness: 300, damping: 18 } }}
              >
                <GenerationStatCard
                  label="本月调用"
                  value={generation?.month.calls ?? 0}
                  desc="模型调用次数"
                  icon={SparklesIcon}
                  color="text-violet-500"
                  animate
                  loading={generation === null}
                />
              </StaggerItem>
              <StaggerItem
                whileHover={{ y: -4, transition: { type: 'spring', stiffness: 300, damping: 18 } }}
              >
                <GenerationStatCard
                  label="本月成功"
                  value={generation?.month.success ?? 0}
                  desc="成功调用次数"
                  icon={CheckCircleIcon}
                  color="text-emerald-500"
                  animate
                  loading={generation === null}
                />
              </StaggerItem>
              <StaggerItem
                whileHover={{ y: -4, transition: { type: 'spring', stiffness: 300, damping: 18 } }}
              >
                <GenerationStatCard
                  label="本月成功率"
                  value={`${generation?.month.successRate ?? 0}%`}
                  desc="成功 / 调用"
                  icon={PercentIcon}
                  color="text-blue-500"
                  loading={generation === null}
                />
              </StaggerItem>
              <StaggerItem
                whileHover={{ y: -4, transition: { type: 'spring', stiffness: 300, damping: 18 } }}
              >
                <GenerationStatCard
                  label="累计成功率"
                  value={`${generation?.total.successRate ?? 0}%`}
                  desc={`累计 ${generation?.total.calls ?? 0} 次调用`}
                  icon={TrendingUpIcon}
                  color="text-amber-500"
                  loading={generation === null}
                />
              </StaggerItem>
            </StaggerContainer>
          )}
        </div>
      )}

      {/* 财务概览（调研报告 Top10 / C7）：GMV / 付费用户 / 转化率 / 热销插件。
          后端基于 Purchase/Plugin 聚合，平台抽成暂为 0（ADR-0002）。 */}
      {financeOpen && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <WalletIcon className="size-4 text-emerald-500" />
            <h2 className="text-sm font-semibold">财务概览</h2>
            <span className="text-xs text-muted-foreground">平台抽成暂为 0，GMV 为交易总额</span>
          </div>
          {financeResource.status === 'error' ? (
            <AsyncResource
              status={financeResource.status}
              error={financeResource.error}
              retry={financeResource.reload}
            >
              {null}
            </AsyncResource>
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <StaggerContainer className="grid gap-4 sm:grid-cols-2" stagger={0.08}>
                <StaggerItem
                  whileHover={{
                    y: -4,
                    transition: { type: 'spring', stiffness: 300, damping: 18 },
                  }}
                >
                  <GenerationStatCard
                    label="本月 GMV"
                    value={money(finance?.month.gmvCents ?? 0)}
                    desc="本月交易总额"
                    icon={WalletIcon}
                    color="text-emerald-500"
                    loading={finance === null}
                  />
                </StaggerItem>
                <StaggerItem
                  whileHover={{
                    y: -4,
                    transition: { type: 'spring', stiffness: 300, damping: 18 },
                  }}
                >
                  <GenerationStatCard
                    label="累计 GMV"
                    value={money(finance?.total.gmvCents ?? 0)}
                    desc="历史交易总额"
                    icon={TrendingUpIcon}
                    color="text-blue-500"
                    loading={finance === null}
                  />
                </StaggerItem>
                <StaggerItem
                  whileHover={{
                    y: -4,
                    transition: { type: 'spring', stiffness: 300, damping: 18 },
                  }}
                >
                  <GenerationStatCard
                    label="付费用户"
                    value={`${finance?.paidUserCount ?? 0} / ${finance?.totalUserCount ?? 0}`}
                    desc="付费 / 总用户"
                    icon={ShoppingCartIcon}
                    color="text-violet-500"
                    loading={finance === null}
                  />
                </StaggerItem>
                <StaggerItem
                  whileHover={{
                    y: -4,
                    transition: { type: 'spring', stiffness: 300, damping: 18 },
                  }}
                >
                  <GenerationStatCard
                    label="付费转化率"
                    value={`${finance?.conversionRate ?? 0}%`}
                    desc="付费用户 / 总用户"
                    icon={PercentIcon}
                    color="text-amber-500"
                    loading={finance === null}
                  />
                </StaggerItem>
              </StaggerContainer>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <StarIcon className="size-4 text-amber-500" />
                    Top 5 热销插件
                  </CardTitle>
                  <CardDescription>按安装数排序</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="px-6 pb-6">
                    {finance === null ? (
                      // 加载中：5 行骨架闪光占位。
                      <div className="space-y-2">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Shimmer key={i} className="h-9 w-full" />
                        ))}
                      </div>
                    ) : (finance?.topPlugins ?? []).length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        <DownloadIcon className="mx-auto mb-1 size-6 text-muted-foreground/50" />
                        暂无上架插件数据
                      </div>
                    ) : (
                      (finance?.topPlugins ?? []).map((plugin, i) => (
                        <div key={plugin.id}>
                          {i > 0 && <Separator className="my-2" />}
                          <div className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm">
                            <div className="flex min-w-0 items-center gap-3">
                              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                                {i + 1}
                              </span>
                              <div className="min-w-0">
                                <div className="truncate font-medium">{plugin.name}</div>
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <span className="flex items-center gap-0.5">
                                    <DownloadIcon className="size-3" />
                                    {plugin.installCount}
                                  </span>
                                  <span className="flex items-center gap-0.5">
                                    <StarIcon className="size-3 text-amber-500" />
                                    {plugin.avgScore}（{plugin.ratingCount}）
                                  </span>
                                </div>
                              </div>
                            </div>
                            <Badge variant="outline">
                              {plugin.priceCents === 0 ? '免费' : money(plugin.priceCents)}
                            </Badge>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* 插件安装量简易条形图：基于财务 Top5 的 installCount，用 framer-motion 画 div 宽度动画，不引图表库。 */}
      {(finance?.topPlugins ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <DownloadIcon className="size-4 text-blue-500" />
              插件安装量（Top 5）
            </CardTitle>
            <CardDescription>相对最大安装量归一化展示</CardDescription>
          </CardHeader>
          <CardContent>
            <MiniBarChart
              data={(finance?.topPlugins ?? []).map((p) => ({
                label: p.name,
                value: p.installCount,
              }))}
              formatValue={(v) => `${v.toLocaleString('zh-CN')} 次`}
              colorClassName="bg-blue-500"
            />
          </CardContent>
        </Card>
      )}

      {/* Pending / Todo */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">待办事项</CardTitle>
            <CardDescription>需要关注的处理项</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {baseLoading ? (
              <div className="space-y-3 px-6 pb-6" role="status" aria-label="正在加载待办事项">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Shimmer key={index} className="h-10 w-full" />
                ))}
              </div>
            ) : dashboard.status === 'error' ? (
              <AsyncResource
                status={dashboard.status}
                error={dashboard.error}
                retry={dashboard.reload}
                className="min-h-36 border-0 bg-transparent"
              >
                {null}
              </AsyncResource>
            ) : (
              <div className="px-6 pb-6">
                {pendingTasks.map((task, i) => {
                  const clickable = Boolean(task.view && onNavigate);
                  return (
                    <div key={task.label}>
                      {i > 0 && <Separator className="my-2" />}
                      <div
                        className={cn(
                          'flex items-center justify-between rounded-lg px-3 py-2.5 text-sm',
                          clickable && 'cursor-pointer transition-colors hover:bg-accent'
                        )}
                        role={clickable ? 'button' : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onClick={
                          clickable ? () => onNavigate?.(task.view!, task.intent) : undefined
                        }
                      >
                        <div className="flex items-center gap-3">
                          <task.icon className={cn('size-4', task.color)} />
                          <span>{task.label}</span>
                        </div>
                        <Badge variant="outline">{task.count}</Badge>
                      </div>
                    </div>
                  );
                })}
                {pendingTasks.every((task) => task.count === 0) && (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    <CheckCircleIcon className="mx-auto mb-1 size-6 text-emerald-500" />
                    暂无待处理事项
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">快速操作</CardTitle>
            <CardDescription>常用管理入口</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="px-6 pb-6">
              {quickActions.map((item, i) => {
                const Icon = item.icon;
                // ADMIN-VIEW-02：有 onNavigate 时整项可点击跳转；无 onNavigate 时移除 cursor-pointer/hover/Arrow，
                // 避免三重视觉暗示「可点击」但点击无反应的死链误导。
                const clickable = Boolean(onNavigate);
                return (
                  <div key={item.label}>
                    {i > 0 && <Separator className="my-2" />}
                    <button
                      type="button"
                      onClick={() => onNavigate?.(item.view, item.intent)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm',
                        clickable && 'cursor-pointer transition-colors hover:bg-muted/50'
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <Icon className="size-4 text-muted-foreground" />
                        <span>{item.label}</span>
                      </span>
                      {clickable && <ArrowRightIcon className="size-4 text-muted-foreground" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** 基础指标卡片的加载/内容切换：loading 时渲染骨架闪光块，否则渲染真实卡片内容。
 *  保留外层 StaggerItem 交错入场不受 loading 影响（骨架与真实内容都会交错进入）。 */
function StatCardSkeletonOrContent({
  loading,
  children,
}: {
  loading: boolean;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <Shimmer className="h-3 w-16" />
          <Shimmer className="size-4 rounded" />
        </CardHeader>
        <CardContent>
          <Shimmer className="mb-2 h-7 w-24" />
          <Shimmer className="h-3 w-20" />
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}

/** 通用指标卡片：复用于 AI 生成质量与财务概览区块。
 *  - value 为字符串/数字均支持（百分比、金额等已格式化为字符串）。
 *  - animate 为 true 时对纯数字 value 做滚动动画（字符串如「85%」不做滚动）。
 *  - loading 时渲染骨架闪光块，避免 NaN；后端聚合对空表已兜底 0。 */
function GenerationStatCard({
  label,
  value,
  desc,
  icon: Icon,
  color,
  animate = false,
  loading = false,
}: {
  label: string;
  value: string | number;
  desc: string;
  icon: typeof UsersIcon;
  color: string;
  animate?: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <Shimmer className="h-3 w-16" />
          <Shimmer className="size-4 rounded" />
        </CardHeader>
        <CardContent>
          <Shimmer className="mb-2 h-7 w-24" />
          <Shimmer className="h-3 w-20" />
        </CardContent>
      </Card>
    );
  }
  // 仅纯数字做滚动；含 %/¥/字符串的指标直接展示（滚动含非数字会错乱）。
  const numeric = typeof value === 'number';
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardDescription>{label}</CardDescription>
        <Icon className={cn('size-4', color)} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">
          {animate && numeric ? <AnimatedNumber value={value} /> : value}
        </div>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </CardContent>
    </Card>
  );
}
