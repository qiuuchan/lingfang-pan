import { SettingsIcon, UserRoundIcon, UsersIcon, WalletIcon, type LucideIcon } from 'lucide-react';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AccountSettingsTab } from '@/lib/types';
import { cn } from '@/lib/utils';

interface AccountNavItem {
  readonly value: AccountSettingsTab;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const ACCOUNT_NAV_ITEMS = [
  { value: 'account', label: '账户', description: '资料与登录', icon: UserRoundIcon },
  { value: 'team', label: '团队空间', description: '余额与概览', icon: UsersIcon },
  { value: 'wallet', label: '钱包', description: '余额与消费', icon: WalletIcon },
  { value: 'settings', label: '设置', description: '模型与平台', icon: SettingsIcon },
] satisfies readonly AccountNavItem[];

export function AccountSettingsNav({ value }: { value: AccountSettingsTab }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/20">
      <div className="border-b px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-primary">
            <UserRoundIcon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">账户中心</span>
            <span className="block truncate text-xs text-muted-foreground">个人、团队与应用</span>
          </span>
        </div>
      </div>
      <TabsList variant="line" className="flex w-full flex-1 items-stretch justify-start gap-1 rounded-none bg-transparent p-2.5">
        {ACCOUNT_NAV_ITEMS.map((item) => (
          <AccountNavTrigger key={item.value} active={value === item.value} item={item} />
        ))}
      </TabsList>
    </aside>
  );
}

function AccountNavTrigger({ active, item }: { active: boolean; item: AccountNavItem }) {
  const Icon = item.icon;
  return (
    <TabsTrigger
      value={item.value}
      className={cn(
        'h-[3.25rem] flex-none justify-start gap-3 rounded-lg border border-transparent px-3 py-2 text-left text-sm text-muted-foreground shadow-none',
        'after:hidden hover:border-border/70 hover:bg-background/70 hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring/45',
        'data-active:border-border data-active:bg-background data-active:text-foreground data-active:shadow-sm',
        'dark:data-active:border-border dark:data-active:bg-background/95 [&_svg]:size-4',
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors',
          active && 'border-primary/30 bg-primary/10 text-primary',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5">{item.label}</span>
        <span className={cn('block truncate text-xs leading-4 text-muted-foreground/80', active && 'text-muted-foreground')}>
          {item.description}
        </span>
      </span>
    </TabsTrigger>
  );
}
