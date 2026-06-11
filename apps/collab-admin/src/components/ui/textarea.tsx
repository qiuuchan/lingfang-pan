import * as React from 'react';
import { cn } from '@/lib/utils';

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40', className)} {...props} />;
}