import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { labelOf } from '@/lib/types';

export function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Panel({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
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
    <div className="grid gap-2 rounded-xl border bg-muted/20 p-3 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="grid gap-1 sm:grid-cols-[96px_1fr]">
          <div className="text-muted-foreground">{label}</div>
          <div className="min-w-0 break-all text-foreground">{value || '—'}</div>
        </div>
      ))}
    </div>
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
  return <div className="flex items-center gap-2">{children}</div>;
}