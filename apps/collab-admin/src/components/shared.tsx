import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { labelOf } from '@/lib/types';

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <div className="mb-3">
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  );
}

export function InfoGrid({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y rounded-lg border text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[112px_1fr] sm:gap-3">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all text-foreground">
            {value === null || value === undefined || value === '' ? '—' : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const map: Record<string, BadgeVariant> = {
    ACTIVE: 'success',
    ENABLED: 'success',
    APPROVED: 'success',
    PENDING: 'warning',
    PLATFORM_ADMIN: 'default',
    TEAM_ADMIN: 'default',
    DISABLED: 'destructive',
    REJECTED: 'destructive',
    SUSPENDED: 'destructive',
    NONE: 'secondary',
    MEMBER: 'secondary',
  };
  const variant = map[value] || 'secondary';
  return <Badge variant={variant}>{labelOf(value)}</Badge>;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
