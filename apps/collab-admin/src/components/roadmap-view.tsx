import { MapIcon, CheckCircle2Icon, Clock3Icon, AlertTriangleIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const sections = [
  {
    title: '已完成基础',
    icon: CheckCircle2Icon,
    tone: 'text-emerald-600',
    items: [
      '插件注册、审核与团队授权',
      '桌面插件 Action 与工作流运行器',
      '本地 Cron 定时任务与运行历史',
      '管理员密码重置链路',
    ],
  },
  {
    title: '当前迭代',
    icon: Clock3Icon,
    tone: 'text-blue-600',
    items: [
      '多插件并行运行状态',
      '定时任务真实调用插件 Action',
      '工作流实例插件与嵌套调用',
      'Cloud 定时任务迁移到本地执行',
    ],
  },
  {
    title: '后续规划',
    icon: AlertTriangleIcon,
    tone: 'text-amber-600',
    items: [
      '管理端统一运行观测与失败告警',
      '工作流节点调试、版本对比与回滚',
      '托盘常驻、可选重试和调度策略',
      '插件依赖升级与能力审计',
    ],
  },
];

export function RoadmapView() {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <MapIcon className="size-5 text-primary" />
          <h1 className="text-2xl font-semibold">未来规划</h1>
          <Badge variant="outline">2026 Q3</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          平台当前状态、进行中的交付和下一阶段里程碑。
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {sections.map(({ title, icon: Icon, tone, items }) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className={`size-5 ${tone}`} />
                {title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm">
                {items.map((item) => (
                  <li key={item} className="border-l-2 border-muted pl-3 leading-relaxed">
                    {item}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        详细兼容策略和版本说明见 docs/roadmap.md。Cloud
        历史数据保留用于查看和迁移，不再接受新的执行请求。
      </p>
    </div>
  );
}
