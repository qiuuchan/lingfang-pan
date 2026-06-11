import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { UsersIcon, BoxesIcon, ClockIcon, PlugIcon, AlertCircleIcon, CheckCircleIcon, ArrowRightIcon } from 'lucide-react';
import { useLoad } from '@/lib/helpers';
import { api, type DashboardData } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  useLoad(() => api<DashboardData>('/api/admin/dashboard').then(setData));

  const stats = [
    { label: '用户总数', value: data?.users ?? 0, desc: '全平台账号', icon: UsersIcon, color: 'text-blue-500' },
    { label: '团队总数', value: data?.teams ?? 0, desc: '活跃/停用团队', icon: BoxesIcon, color: 'text-emerald-500' },
    { label: '待审批', value: data?.pendingApplications ?? 0, desc: '团队管理员申请', icon: ClockIcon, color: 'text-amber-500' },
    { label: '启用插件', value: data?.enabledPlugins ?? 0, desc: '本地客户端可见', icon: PlugIcon, color: 'text-violet-500' },
  ];

  const pendingTasks = [
    { label: '待审批申请', count: data?.pendingApplications ?? 0, icon: AlertCircleIcon, href: '#applications', color: 'text-amber-500' },
    { label: '已禁用插件', count: 0, icon: CheckCircleIcon, href: '#plugins', color: 'text-muted-foreground' },
  ];

  return (
    <div className="space-y-8">
      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, desc, icon: Icon, color }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardDescription>{label}</CardDescription>
              <Icon className={cn('size-4', color)} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{value}</div>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pending / Todo */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">待办事项</CardTitle>
            <CardDescription>需要关注的处理项</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingTasks.map((task) => (
              <div
                key={task.label}
                className="flex items-center justify-between rounded-lg border p-3 text-sm"
              >
                <div className="flex items-center gap-3">
                  <task.icon className={cn('size-4', task.color)} />
                  <span>{task.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{task.count}</Badge>
                </div>
              </div>
            ))}
            {pendingTasks.every((t) => t.count === 0) && (
              <div className="py-4 text-center text-sm text-muted-foreground">
                <CheckCircleIcon className="mx-auto mb-1 size-6 text-emerald-500" />
                暂无待处理事项
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">快速操作</CardTitle>
            <CardDescription>常用管理入口</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: '创建用户', icon: UsersIcon },
              { label: '创建团队', icon: BoxesIcon },
              { label: '审批管理', icon: CheckCircleIcon },
            ].map((item) => (
              <div
                key={item.label}
                className="flex cursor-pointer items-center justify-between rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <item.icon className="size-4 text-muted-foreground" />
                  <span>{item.label}</span>
                </div>
                <ArrowRightIcon className="size-4 text-muted-foreground" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}