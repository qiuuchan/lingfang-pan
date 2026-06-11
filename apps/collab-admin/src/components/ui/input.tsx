import * as React from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('h-10 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none transition-shadow placeholder:text-muted-foreground/70 focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />;
}