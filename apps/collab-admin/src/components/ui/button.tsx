import * as React from 'react';
import { cn } from '@/lib/utils';

export function Button({ className, variant = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'destructive' }) {
  return (
    <button
      className={cn(
        'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium leading-none shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-50',
        variant === 'default' && 'bg-primary text-primary-foreground hover:bg-primary/85',
        variant === 'outline' && 'border border-border bg-background text-foreground hover:bg-muted',
        variant === 'ghost' && 'bg-transparent shadow-none hover:bg-muted',
        variant === 'destructive' && 'border border-destructive/20 bg-destructive/10 text-destructive shadow-none hover:bg-destructive/20',
        className,
      )}
      {...props}
    />
  );
}